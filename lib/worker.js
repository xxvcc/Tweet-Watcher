'use strict';
// 调度 worker：按账号间隔拉取、去重、重试推送。与面板同进程。
// 账号之间以受限并发执行（不同账号 -> 不同去重键，无共享状态竞态），避免单个慢/死账号队头阻塞其余账号。
const crypto = require('crypto');
const store = require('./store');
const cfgmod = require('./config');
const bird = require('./bird');
const tg = require('./telegram');
const state = require('./state');

const TICK_MS = 5000;
const MAX_CONCURRENT_CHECKS = 4; // 同时在检查的账号上限（也即并发 bird 子进程上限）
const MAX_BACKOFF_MS = 3600e3;   // Telegram 洪泛退避上限
const TWITTER_SNOWFLAKE_EPOCH_MS = 1288834974657n;

let sentIds = Object.create(null);   // 去重表（null 原型，避免 __proto__ 等保留字账号名污染键语义）
let lastCheck = Object.create(null); // username -> ts(ms)
let running = false;
let pausedNow = false;               // 易失暂停标志：由 /api/control 直接置位，实现"暂停即时生效"
const tgBackoffs = new Map();         // bot token 指纹 -> { until, noticeAt }，不同 bot 的 429 互不污染
let configGeneration = 0;            // 配置/暂停变更时取消仍在途的旧快照
let persistedConfigSeen = false;      // 防运行中整个 data/ 消失后退化为“首次空配置”并清空去重表

function observeConfigPresence(cfg) {
  // 测试桩和旧调用方没有 persisted 字段，按正常持久配置处理；只有配置模块明确返回 false
  // 才表示当前是合法首启默认值。一个进程见过真实配置后，这个状态不得再倒退。
  if (cfg && cfg.persisted === false) {
    if (persistedConfigSeen) {
      const error = new Error('config.json 运行中缺失，已拒绝回退为空配置');
      error.code = 'DATA_CORRUPT';
      throw error;
    }
    return;
  }
  persistedConfigSeen = true;
}

// 等待期间也维持 worker 心跳。按剩余时长递减，不依赖可回拨的系统墙上时钟。
async function sleep(ms) {
  let remaining = Math.max(0, Number(ms) || 0);
  do {
    const chunk = Math.min(15000, remaining);
    await new Promise((r) => setTimeout(r, chunk));
    remaining -= chunk;
    state.setStatus({ lastTickAt: Date.now() });
  } while (remaining > 0);
}

function normalizeStoredIds(ids) {
  if (!Array.isArray(ids)) return null;
  // 空数组不是正常持久化状态：首拉为空明确不会建基线。把旧版/损坏的 [] 当首次运行，
  // 否则恢复后第一批真实时间线会被全部当成新推文发送。
  if (ids.length === 0) return null;
  if (ids.length > cfgmod.LIMITS.MAX_SENT * 2) return null;
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    let id;
    if (typeof raw === 'string') id = raw.trim();
    else if (typeof raw === 'number' && Number.isSafeInteger(raw)) id = String(raw);
    else return null;
    if (!/^\d{1,32}$/.test(id)) return null;
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out.slice(-cfgmod.LIMITS.MAX_SENT);
}

function loadSent() {
  const raw = store.readJSON('sent_ids.json', {}) || {};
  sentIds = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const [user, ids] of Object.entries(raw)) sentIds[user] = normalizeStoredIds(ids);
}
function safeSaveSent() {
  try { store.writeJSON('sent_ids.json', sentIds); }
  catch (e) { state.log(`保存去重表失败：${(e && e.message) || e}`); } // 落盘失败不得中断调度
}

// 供 Web 路由通知在途任务和其他面板标签页：旧快照不得继续发消息。
function configChanged(revision) {
  configGeneration++;
  // 对外版本来自 config.json，不能在此使用重启后归零的内存计数。
  const persisted = cfgmod.validRevision(revision) ? revision : cfgmod.getConfig().revision;
  state.setStatus({ configRevision: persisted });
}
// 供 /api/control 即时置位暂停态，无需等下一 tick 读盘
function setPaused(v) { pausedNow = !!v; configGeneration++; }

// 从日志字符串里抹掉可能被 bird/错误输出带出的凭据值
function redact(s, secrets) {
  let out = String(s == null ? '' : s);
  for (const v of [secrets.auth_token, secrets.ct0, secrets.tg_bot_token]) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}
// 取当前凭据用于脱敏；读盘失败时宁可不记日志内容，也不能裸奔输出
function safeRedact(s) {
  try { return redact(s, cfgmod.getSecrets()); } catch (_) { return '（内容已省略）'; }
}

function botKey(botToken) {
  return crypto.createHash('sha256').update(String(botToken || '')).digest('hex');
}

function normalizeBackoffClock(entry, now) {
  if (Number.isFinite(entry.lastNow) && now < entry.lastNow) {
    const rollback = entry.lastNow - now;
    // 平移绝对时间锚点，保持回拨前的剩余退避时长不变。
    entry.until -= rollback;
    if (entry.noticeAt > 0) entry.noticeAt = Math.max(0, entry.noticeAt - rollback);
  }
  entry.lastNow = now;
}

function setTelegramBackoff(botToken, retryAfter) {
  const now = Date.now();
  const rawSeconds = Number(retryAfter);
  const wait = Math.min(
    MAX_BACKOFF_MS,
    Math.max(2000, Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds * 1000 : 0),
  );
  const key = botKey(botToken);
  for (const [k, entry] of tgBackoffs) {
    normalizeBackoffClock(entry, now);
    if (entry.until <= now) tgBackoffs.delete(k);
  }
  if (!tgBackoffs.has(key) && tgBackoffs.size >= 16) {
    let oldestKey = null;
    let oldestUntil = Infinity;
    for (const [k, entry] of tgBackoffs) {
      if (entry.until < oldestUntil) { oldestKey = k; oldestUntil = entry.until; }
    }
    if (oldestKey) tgBackoffs.delete(oldestKey);
  }
  const previous = tgBackoffs.get(key);
  const until = Math.max(previous ? previous.until : 0, now + wait);
  tgBackoffs.set(key, { until, noticeAt: 0, lastNow: now });
  // 多个并发请求可能先后收到不同 retry_after。调用方需要展示合并后的真实剩余时间，
  // 不能用最后一个（可能更短的）响应误报退避即将结束。
  return until - now;
}

// Telegram 洪泛退避是否生效。日志每分钟最多一行，避免 100 个账号 × 每 5 秒刷屏。
function backoffActive(botToken) {
  const key = botKey(botToken);
  const entry = tgBackoffs.get(key);
  if (!entry) return 0;
  const now = Date.now();
  normalizeBackoffClock(entry, now);
  if (now >= entry.until) { tgBackoffs.delete(key); return 0; }
  if (now - entry.noticeAt > 60000) {
    entry.noticeAt = now;
    state.log(`⏸ Telegram 退避中，还需 ${Math.ceil((entry.until - now) / 1000)}s；期间新推文顺延推送`);
  }
  return entry.until - now;
}

// 受限并发执行：items 逐个交给 fn，最多 limit 个同时在跑
async function runPool(items, limit, fn) {
  const queue = items.slice();
  const workers = [];
  const n = Math.min(limit, queue.length);
  for (let i = 0; i < n; i++) {
    workers.push((async () => {
      while (queue.length) { await fn(queue.shift()); }
    })());
  }
  await Promise.all(workers);
}

// MAX_SENT 淘汰按插入顺序进行。若直接 slice(-MAX_SENT)，长期置顶的推文（始终出现在
// 每次拉取窗口内）会被挤出去重表并被重复推送一次，此后每满 MAX_SENT 条又重复一次。
// 故淘汰时把"本次仍出现在时间线里"的 ID 移到队尾优先保留，并顺带清理历史重复。
function trimSent(user, tweets) {
  const visible = new Set(tweets.map((t) => String(t.id)));
  const uniq = [...new Set(sentIds[user])];
  const keep = uniq.filter((id) => visible.has(id));
  const rest = uniq.filter((id) => !visible.has(id));
  const room = Math.max(0, cfgmod.LIMITS.MAX_SENT - keep.length);
  sentIds[user] = (room > 0 ? rest.slice(-room) : []).concat(keep); // room=0 时 slice(-0) 会返回整个数组
}

function emptyTimelineWatermark(now) {
  const numeric = Number(now);
  const timestamp = Number.isFinite(numeric) && numeric > 0 ? BigInt(Math.trunc(numeric)) : 0n;
  const elapsed = timestamp > TWITTER_SNOWFLAKE_EPOCH_MS
    ? timestamp - TWITTER_SNOWFLAKE_EPOCH_MS : 0n;
  // Snowflake 低 22 位是同毫秒内的 worker/sequence。记录该毫秒之前的最大值，
  // 使同毫秒内的任意真实 ID（包括低 22 位全 0）都会被视为新推文。
  return elapsed > 0n ? ((elapsed << 22n) - 1n).toString() : '0';
}

async function checkAccount(acct, cfg, secrets, startedAt, generation) {
  const user = acct.username;
  state.setAccount(user, { checking: true });
  try {
    const res = await bird.fetchTweets({
      birdPath: cfg.bird_path, username: user, count: acct.fetch_count,
      authToken: secrets.auth_token, ct0: secrets.ct0,
    });

    // 无论成功失败，旧配置快照的结果都不得覆盖新配置下的账号状态。
    if (pausedNow || generation !== configGeneration) return;

    if (!res.ok) {
      const detail = [res.error, res.raw].filter(Boolean).join('：') || '未知';
      const safeDetail = redact(detail, secrets);
      state.log(`✗ 拉取 @${user} 失败：${safeDetail}`);
      state.setAccount(user, { checking: false, lastCheck: startedAt, ok: false, lastError: safeDetail });
      return;
    }

    const tweets = res.tweets;
    // 值损坏（非数组）也按首次运行处理：否则 known 会被静默降级成空集，
    // 而 isFirst 又为 false，导致整批推文被当作新推文全量重推。
    const isFirst = !(user in sentIds) || !Array.isArray(sentIds[user]);
    if (isFirst) {
      if (tweets.length === 0) {
        // 用检查开始时刻的 Snowflake 下界建立空基线：避免下次出现的第一条真实推文再次被当作
        // “首次已有时间线”静默吞掉，同时仍不会补发早于本次成功空拉取的历史条目。
        // 必须用请求开始时间：在慢请求期间发布、但未进入本次快照的推文
        // 应在下一轮送达，不能被请求完成时刻的水位永久跳过。
        sentIds[user] = [emptyTimelineWatermark(startedAt)];
        safeSaveSent();
        state.log(`@${user} 首次拉取为空，已记录时间水位，不推送历史推文`);
        state.setAccount(user, { checking: false, lastCheck: startedAt, ok: true, lastError: null, lastPushed: 0 });
        return;
      }
      sentIds[user] = [...new Set(tweets.map((t) => String(t.id)))]; // 批内去重：置顶推常出现两次
      safeSaveSent();
      state.log(`@${user} 首次运行，记录 ${sentIds[user].length} 条推文 ID，不推送`);
      state.setAccount(user, { checking: false, lastCheck: startedAt, ok: true, lastError: null, lastPushed: 0 });
      return;
    }

    const known = new Set(sentIds[user]);
    let newestKnown = null;
    for (const id of known) {
      const value = BigInt(id);
      if (newestKnown === null || value > newestKnown) newestKnown = value;
    }
    const seen = new Set();
    // 对历史已推 + 本批次内部同时去重，并忽略低于已知最高雪花 ID 的未知旧推文。
    // 这类条目通常是刚被置顶、或扩大 fetch_count 后重新进入窗口的历史推文，不应补发。
    // 不能依赖 bird 的数组顺序再 reverse；按雪花 ID 升序才是稳定的"最旧->最新"。
    const fresh = tweets.filter((t) => {
      const id = String(t.id);
      if (known.has(id) || seen.has(id)) return false;
      seen.add(id);
      return newestKnown === null || BigInt(id) > newestKnown;
    }).sort((a, b) => {
      const ai = BigInt(String(a.id));
      const bi = BigInt(String(b.id));
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });

    if (fresh.length === 0) {
      state.log(`@${user} 无新推文`);
      state.pushHistory(user, 0);
      state.setAccount(user, { checking: false, lastCheck: startedAt, ok: true, lastError: null, lastPushed: 0 });
      return;
    }

    let pushed = 0;
    let deliveryError = null;
    let interrupted = false;
    for (const t of fresh) {
      if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
      if (backoffActive(secrets.tg_bot_token)) { deliveryError = 'Telegram 退避中，推送已顺延'; break; }
      const text = tg.formatTweet(t, user);
      let ok = false;
      let sendError = '发送失败';
      for (let attempt = 0; attempt < 3; attempt++) {
        // 每次重试前都重新检查暂停、配置代次与另一并发槽触发的全局退避。
        if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
        if (backoffActive(secrets.tg_bot_token)) { deliveryError = 'Telegram 退避中，推送已顺延'; break; }
        const send = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text });
        if (send.ok) { ok = true; break; }
        sendError = redact(send.description || '发送失败', secrets);
        if (send.rateLimited) {
          // 即使请求在途时发生暂停/配置变更，也必须记住原 bot 的 retry_after；否则恢复后会立刻重发。
          const wait = setTelegramBackoff(secrets.tg_bot_token, send.retryAfter);
          if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
          deliveryError = `Telegram 限流，推送顺延 ${Math.round(wait / 1000)}s`;
          state.log(`⏸ ${deliveryError}`);
          break;
        }
        if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
        if (backoffActive(secrets.tg_bot_token)) { deliveryError = 'Telegram 退避中，推送已顺延'; break; }
        if (send.permanent) { state.log(`  Telegram(永久失败，不重试): ${sendError}`); break; }
        if (attempt === 2) { state.log(`  Telegram: ${sendError}`); break; }
        state.log(`↻ 重试 @${user}: ${t.id}（2s 后）`);
        await sleep(2000);
      }
      if (ok) {
        pushed++;
        sentIds[user].push(String(t.id));
        state.addPush(user, t);
        state.log(`✓ 推送 @${user}: ${t.id}`);
      } else {
        if (!interrupted && !deliveryError) deliveryError = `Telegram 推送失败：${sendError}`;
        if (deliveryError) state.log(`✗ 推送失败 @${user}: ${t.id}（${deliveryError}）`);
        break; // 保持“最旧 -> 最新”交付顺序；旧推文失败时不得越过它发送更新推文
      }
      await sleep(500);
    }

    // 本账号推送结束后统一落盘（去掉每条推文一次的写放大；崩溃至多导致已发未记 -> 下轮重发，
    // 与既有 at-least-once 语义一致）。一条都没推成功时无需写盘。
    if (pushed > 0) {
      trimSent(user, tweets);
      safeSaveSent();
    }
    // 最后一条成功发送后的节流等待也可能跨过暂停/配置变更。已送达 ID 必须落盘，
    // 但旧快照不得再写 history/账号状态，否则会把已删除账号重新建回运行时状态。
    if (pausedNow || generation !== configGeneration) return;
    state.pushHistory(user, pushed);
    const patch = { checking: false, lastCheck: startedAt, lastPushed: pushed };
    if (deliveryError) { patch.ok = false; patch.lastError = deliveryError; }
    else if (!interrupted) { patch.ok = true; patch.lastError = null; }
    state.setAccount(user, patch);
  } finally {
    // 兜底：任何异常路径也复位 checking，避免面板徽章永久卡在"检查中…"
    const s = state.getStatus().accounts[user];
    if (s && s.checking) state.setAccount(user, { checking: false });
  }
}

async function tick() {
  let cfg;
  let secrets;
  try {
    cfg = cfgmod.getConfig();
    observeConfigPresence(cfg);
    secrets = cfgmod.getSecrets();
  }
  catch (e) {
    // 配置损坏时不能继续更新心跳并对外谎报 healthy。文件修复后下轮会自动恢复。
    state.setStatus({ running: false, lastTickAt: null });
    throw e;
  }
  state.setStatus({ running: true, lastTickAt: Date.now(), configRevision: cfg.revision });
  // 配置快照与代次必须一起捕获。排队任务不能在稍后取得槽位时给旧快照套上新代次。
  const tickGeneration = configGeneration;
  pausedNow = !!cfg.paused;
  state.setStatus({ paused: pausedNow });

  // 清理已删除账号的去重记录/计时/状态
  const active = cfg.accounts.map((a) => a.username);
  const activeSet = new Set(active);
  let sentChanged = false;
  // 合法的去重表单文件迁移会在 config.json 之前出现。默认首启配置尚未落盘时不得把
  // 这些 ID 当成“已删除账号”清掉；配置一旦保存，再按真实账号列表正常收敛。
  if (cfg.persisted !== false) {
    for (const u of Object.keys(sentIds)) if (!activeSet.has(u)) { delete sentIds[u]; sentChanged = true; }
  }
  for (const u of Object.keys(lastCheck)) if (!activeSet.has(u)) delete lastCheck[u];
  if (sentChanged) safeSaveSent();
  state.pruneAccounts(active);

  if (!pausedNow) {
    const now = Date.now();
    const due = cfg.accounts.filter((a) => {
      const previous = lastCheck[a.username];
      // 墙上时钟可能因 NTP/人工校时回拨。若仍直接做差，回拨一天就会让该账号
      // 在心跳持续正常的同时停查一天；检测到回拨时立即重新建立调度锚点。
      return previous == null || now < previous || now - previous >= a.check_interval * 1000;
    });
    await runPool(due, MAX_CONCURRENT_CHECKS, async (acct) => {
      if (pausedNow || tickGeneration !== configGeneration) return;
      // 排队账号只有在真正获得池槽时才算“开始检查”；暂停时未启动的账号保持立即到期。
      const startedAt = Date.now();
      lastCheck[acct.username] = startedAt;
      try { await checkAccount(acct, cfg, secrets, startedAt, tickGeneration); }
      catch (e) { state.log(`检查 @${acct.username} 异常：${redact((e && e.message) || e, secrets)}`); }
      // 暂停或配置变更取消了本次工作时不消耗检查周期；恢复/新配置应立即重新检查。
      if (tickGeneration !== configGeneration) delete lastCheck[acct.username];
      state.setStatus({ lastTickAt: Date.now() }); // 心跳：长 tick 期间也持续更新，避免误判为死 worker
    });
  }

  state.setStatus({ lastTickAt: Date.now() }); // 心跳，供 /api/status 判活
}

async function loop() {
  try { await tick(); }
  catch (e) {
    // DATA_CORRUPT 消息只包含固定文件名，直接告知面板；其他异常仍必须经凭据脱敏。
    const detail = e && e.code === 'DATA_CORRUPT' ? e.message : safeRedact((e && e.message) || e);
    state.log(`tick 异常：${detail}`);
  }
  finally { setTimeout(loop, TICK_MS); } // 无论如何都排下一轮，杜绝调度永久停摆
}

function start() {
  if (running) return;
  running = true;
  loadSent();
  let revision = 0;
  try {
    const cfg = cfgmod.getConfig();
    observeConfigPresence(cfg);
    revision = cfg.revision;
  }
  catch (e) { state.log(`配置读取失败，监控将保持停止：${(e && e.message) || e}`); }
  state.setStatus({ running: true, startedAt: Date.now(), configRevision: revision });
  state.log('监控服务已启动');
  loop();
}

// —— 供面板即时调用的测试 ——
async function testBird(username) {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const requested = typeof username === 'string' ? username : '';
  const user = (requested || (cfg.accounts[0] && cfg.accounts[0].username) || 'elonmusk').replace(/^@/, '').trim();
  const res = await bird.fetchTweets({ birdPath: cfg.bird_path, username: user, count: 1, authToken: secrets.auth_token, ct0: secrets.ct0 });
  if (!res.ok) return { ok: false, message: redact([res.error, res.raw].filter(Boolean).join('：') || '拉取失败', secrets) };
  const t = res.tweets[0];
  return { ok: true, message: t ? `拉取 @${user} 成功，最新推文：${(t.text || '').slice(0, 80)}` : `@${user} 无推文，但连接正常` };
}

async function testTelegram() {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const remaining = backoffActive(secrets.tg_bot_token);
  if (remaining > 0) {
    return { ok: false, message: `Telegram 退避中，请 ${Math.ceil(remaining / 1000)} 秒后再测试` };
  }
  const r = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text: '🐦 Tweet Watcher 测试消息 — 配置正确！' });
  if (r.rateLimited) {
    const wait = setTelegramBackoff(secrets.tg_bot_token, r.retryAfter);
    state.log(`⏸ Telegram 测试触发限流，推送顺延 ${Math.round(wait / 1000)}s`);
  }
  return { ok: r.ok, message: r.ok ? 'Telegram 测试消息已发送' : ('发送失败：' + redact(r.description || '', secrets)) };
}

// tick 导出仅作测试/手动触发用；常态调度由 start() 内的 loop 驱动
module.exports = { start, tick, setPaused, configChanged, testBird, testTelegram };
