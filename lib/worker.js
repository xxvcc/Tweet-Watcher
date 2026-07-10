'use strict';
// 调度 worker：按账号间隔拉取、去重、重试推送。与面板同进程。
// 账号之间以受限并发执行（不同账号 -> 不同去重键，无共享状态竞态），避免单个慢/死账号队头阻塞其余账号。
const store = require('./store');
const cfgmod = require('./config');
const bird = require('./bird');
const tg = require('./telegram');
const state = require('./state');

const TICK_MS = 5000;
const MAX_CONCURRENT_CHECKS = 4; // 同时在检查的账号上限（也即并发 bird 子进程上限）
const MAX_RETRY_WAIT_MS = 60000; // 单条推文的重试等待上限
const MAX_BACKOFF_MS = 3600e3;   // Telegram 洪泛退避上限

let sentIds = Object.create(null);   // 去重表（null 原型，避免 __proto__ 等保留字账号名污染键语义）
let lastCheck = Object.create(null); // username -> ts(ms)
let running = false;
let pausedNow = false;               // 易失暂停标志：由 /api/control 直接置位，实现"暂停即时生效"
let tgBackoffUntil = 0;              // Telegram 要求的退避截止时刻（洪泛限制是 bot 级的，故全局共享）
let backoffNoticeAt = 0;             // 退避期间的日志节流

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSent() {
  const raw = store.readJSON('sent_ids.json', {}) || {};
  sentIds = Object.assign(Object.create(null), raw);
}
function safeSaveSent() {
  try { store.writeJSON('sent_ids.json', sentIds); }
  catch (e) { state.log(`保存去重表失败：${(e && e.message) || e}`); } // 落盘失败不得中断调度
}

// 供 /api/control 即时置位暂停态，无需等下一 tick 读盘
function setPaused(v) { pausedNow = !!v; }

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

// Telegram 洪泛退避是否生效。日志每分钟最多一行，避免 100 个账号 × 每 5 秒刷屏。
function backoffActive() {
  const now = Date.now();
  if (now >= tgBackoffUntil) return false;
  if (now - backoffNoticeAt > 60000) {
    backoffNoticeAt = now;
    state.log(`⏸ Telegram 退避中，还需 ${Math.ceil((tgBackoffUntil - now) / 1000)}s；期间新推文顺延推送`);
  }
  return true;
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

async function checkAccount(acct, cfg, secrets, startedAt) {
  const user = acct.username;
  state.setAccount(user, { checking: true });
  try {
    const res = await bird.fetchTweets({
      birdPath: cfg.bird_path, username: user, count: acct.fetch_count,
      authToken: secrets.auth_token, ct0: secrets.ct0,
    });

    if (!res.ok) {
      state.log(`✗ 拉取 @${user} 失败：${redact(res.error || res.raw || '未知', secrets)}`);
      state.setAccount(user, { checking: false, lastCheck: startedAt, ok: false, lastError: res.error || '拉取失败' });
      return;
    }

    const tweets = res.tweets;
    // 值损坏（非数组）也按首次运行处理：否则 known 会被静默降级成空集，
    // 而 isFirst 又为 false，导致整批推文被当作新推文全量重推。
    const isFirst = !(user in sentIds) || !Array.isArray(sentIds[user]);
    if (isFirst) {
      if (tweets.length === 0) {
        // 首拉为空不建立基线：否则下一轮拿到真实时间线时 known 为空，会把全部旧推当新推批量误推。
        state.log(`@${user} 首次拉取为空，暂不建立基线（待有数据再记录）`);
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
    const seen = new Set();
    // 对历史已推 + 本批次内部同时去重（置顶推常在置顶位与时间线各出现一次），再反转为"最旧->最新"顺序推送
    const fresh = tweets.filter((t) => {
      const id = String(t.id);
      if (known.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).reverse();

    if (fresh.length === 0) {
      state.log(`@${user} 无新推文`);
      state.pushHistory(user, 0);
      state.setAccount(user, { checking: false, lastCheck: startedAt, ok: true, lastError: null, lastPushed: 0 });
      return;
    }

    let pushed = 0;
    for (const t of fresh) {
      if (pausedNow) break;    // 暂停即时生效：不再发送本 tick 剩余推文
      if (backoffActive()) break; // Telegram 洪泛退避中：本条留到退避结束后的某轮再推
      const text = tg.formatTweet(t, user);
      let ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const send = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text });
        if (send.ok) { ok = true; break; }
        if (send.permanent) { state.log(`  Telegram(永久失败，不重试): ${redact(send.description || '', secrets)}`); break; }
        const wait = Math.max(2000, (send.retryAfter || 0) * 1000); // 尊重 429 retry_after
        if (wait > MAX_RETRY_WAIT_MS) {
          // 远端要求的等待超过上限。绝不在 tick 内长睡——那会挂住 runPool 槽位并让整个调度停摆。
          // 改为设置全局退避，立即返回，让本条与后续推文顺延到退避结束。
          tgBackoffUntil = Date.now() + Math.min(wait, MAX_BACKOFF_MS);
          backoffNoticeAt = 0;
          state.log(`⏸ Telegram 要求等待 ${Math.round(wait / 1000)}s（超过 ${MAX_RETRY_WAIT_MS / 1000}s 上限）：暂停推送，推文顺延`);
          break;
        }
        if (attempt === 2) { state.log(`  Telegram: ${redact(send.description || '发送失败', secrets)}`); break; }
        state.log(`↻ 重试 @${user}: ${t.id}（${Math.round(wait / 1000)}s 后）`);
        await sleep(wait);
      }
      if (ok) {
        pushed++;
        sentIds[user].push(String(t.id));
        state.addPush(user, t);
        state.log(`✓ 推送 @${user}: ${t.id}`);
      } else if (Date.now() < tgBackoffUntil) {
        break;                 // 刚触发退避：本轮不再尝试后续推文（它们仍未记入 sentIds，下轮重试）
      } else {
        state.log(`✗ 推送失败 @${user}: ${t.id}`);
      }
      await sleep(500);
    }

    // 本账号推送结束后统一落盘（去掉每条推文一次的写放大；崩溃至多导致已发未记 -> 下轮重发，
    // 与既有 at-least-once 语义一致）。一条都没推成功时无需写盘。
    if (pushed > 0) {
      trimSent(user, tweets);
      safeSaveSent();
    }
    state.pushHistory(user, pushed);
    state.setAccount(user, { checking: false, lastCheck: startedAt, ok: true, lastError: null, lastPushed: pushed });
  } finally {
    // 兜底：任何异常路径也复位 checking，避免面板徽章永久卡在"检查中…"
    const s = state.getStatus().accounts[user];
    if (s && s.checking) state.setAccount(user, { checking: false });
  }
}

async function tick() {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  pausedNow = !!cfg.paused;
  state.setStatus({ paused: pausedNow });

  // 清理已删除账号的去重记录/计时/状态
  const active = cfg.accounts.map((a) => a.username);
  const activeSet = new Set(active);
  let sentChanged = false;
  for (const u of Object.keys(sentIds)) if (!activeSet.has(u)) { delete sentIds[u]; sentChanged = true; }
  for (const u of Object.keys(lastCheck)) if (!activeSet.has(u)) delete lastCheck[u];
  if (sentChanged) safeSaveSent();
  state.pruneAccounts(active);

  if (!pausedNow) {
    const now = Date.now();
    const due = cfg.accounts.filter((a) => now - (lastCheck[a.username] || 0) >= a.check_interval * 1000);
    // 调度锚点：下一次检查从本次【开始】时刻起算。同一个 now 也交给 checkAccount 写进
    // state.lastCheck，使面板倒计时与真实调度对齐（否则会晚一个"检查耗时"）。
    for (const a of due) lastCheck[a.username] = now;
    await runPool(due, MAX_CONCURRENT_CHECKS, async (acct) => {
      if (pausedNow) return;
      try { await checkAccount(acct, cfg, secrets, now); }
      catch (e) { state.log(`检查 @${acct.username} 异常：${redact((e && e.message) || e, secrets)}`); }
      state.setStatus({ lastTickAt: Date.now() }); // 心跳：长 tick 期间也持续更新，避免误判为死 worker
    });
  }

  state.setStatus({ lastTickAt: Date.now() }); // 心跳，供 /api/status 判活
}

async function loop() {
  try { await tick(); }
  catch (e) { state.log(`tick 异常：${safeRedact((e && e.message) || e)}`); }
  finally { setTimeout(loop, TICK_MS); } // 无论如何都排下一轮，杜绝调度永久停摆
}

function start() {
  if (running) return;
  running = true;
  loadSent();
  state.setStatus({ running: true, startedAt: Date.now() });
  state.log('监控服务已启动');
  loop();
}

// —— 供面板即时调用的测试 ——
async function testBird(username) {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const user = (username || (cfg.accounts[0] && cfg.accounts[0].username) || 'elonmusk').replace(/^@/, '');
  const res = await bird.fetchTweets({ birdPath: cfg.bird_path, username: user, count: 1, authToken: secrets.auth_token, ct0: secrets.ct0 });
  if (!res.ok) return { ok: false, message: redact(res.error || res.raw || '拉取失败', secrets) };
  const t = res.tweets[0];
  return { ok: true, message: t ? `拉取 @${user} 成功，最新推文：${(t.text || '').slice(0, 80)}` : `@${user} 无推文，但连接正常` };
}

async function testTelegram() {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const r = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text: '🐦 Tweet Watcher 测试消息 — 配置正确！' });
  return { ok: r.ok, message: r.ok ? 'Telegram 测试消息已发送' : ('发送失败：' + redact(r.description || '', secrets)) };
}

// tick 导出仅作测试/手动触发用；常态调度由 start() 内的 loop 驱动
module.exports = { start, tick, setPaused, testBird, testTelegram };
