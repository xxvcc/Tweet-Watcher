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

let sentIds = Object.create(null);   // 去重表（null 原型，避免 __proto__ 等保留字账号名污染键语义）
let lastCheck = Object.create(null); // username -> ts(ms)
let timer = null;
let running = false;
let pausedNow = false;               // 易失暂停标志：由 /api/control 直接置位，实现"暂停即时生效"

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
    if (v && v.length > 6) out = out.split(v).join('***');
  }
  return out;
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

async function checkAccount(acct, cfg, secrets) {
  const user = acct.username;
  state.setAccount(user, { checking: true });
  try {
    const res = await bird.fetchTweets({
      birdPath: cfg.bird_path, username: user, count: acct.fetch_count,
      authToken: secrets.auth_token, ct0: secrets.ct0,
    });

    if (!res.ok) {
      state.log(`✗ 拉取 @${user} 失败：${redact(res.error || res.raw || '未知', secrets)}`);
      state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: false, lastError: res.error || '拉取失败' });
      return;
    }

    const tweets = res.tweets;
    const isFirst = !(user in sentIds);
    if (isFirst) {
      if (tweets.length === 0) {
        // 首拉为空不建立基线：否则下一轮拿到真实时间线时 known 为空，会把全部旧推当新推批量误推。
        state.log(`@${user} 首次拉取为空，暂不建立基线（待有数据再记录）`);
        state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: 0 });
        return;
      }
      sentIds[user] = tweets.map((t) => String(t.id));
      safeSaveSent();
      state.log(`@${user} 首次运行，记录 ${tweets.length} 条推文 ID，不推送`);
      state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: 0 });
      return;
    }

    const known = new Set(Array.isArray(sentIds[user]) ? sentIds[user] : []);
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
      state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: 0 });
      return;
    }

    if (!Array.isArray(sentIds[user])) sentIds[user] = [];
    let pushed = 0;
    for (const t of fresh) {
      if (pausedNow) break; // 暂停即时生效：不再发送本 tick 剩余推文
      const text = tg.formatTweet(t, user);
      let ok = false;
      for (let r = 0; r < 3 && !ok; r++) {
        const send = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text });
        ok = send.ok;
        if (ok) break;
        if (send.permanent) { state.log(`  Telegram(永久失败，不重试): ${redact(send.description || '', secrets)}`); break; }
        if (r < 2) {
          const wait = Math.max(2000, (send.retryAfter || 0) * 1000); // 尊重 429 retry_after
          state.log(`↻ 重试 @${user}: ${t.id}（${Math.round(wait / 1000)}s 后）`);
          await sleep(wait);
        } else {
          state.log(`  Telegram: ${redact(send.description || '发送失败', secrets)}`);
        }
      }
      if (ok) {
        pushed++;
        sentIds[user].push(String(t.id));
        state.log(`✓ 推送 @${user}: ${t.id}`);
      } else {
        state.log(`✗ 推送失败 @${user}: ${t.id}`);
      }
      await sleep(500);
    }

    if (sentIds[user].length > cfgmod.LIMITS.MAX_SENT) {
      sentIds[user] = sentIds[user].slice(-cfgmod.LIMITS.MAX_SENT);
    }
    // 本账号推送结束后统一落盘（去掉每条推文一次的写放大；崩溃至多导致已发未记 -> 下轮重发，
    // 与既有 at-least-once 语义一致）
    safeSaveSent();
    state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: pushed });
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
    for (const a of due) lastCheck[a.username] = Date.now();
    await runPool(due, MAX_CONCURRENT_CHECKS, async (acct) => {
      if (pausedNow) return;
      try { await checkAccount(acct, cfg, secrets); }
      catch (e) { state.log(`检查 @${acct.username} 异常：${e.message}`); }
    });
  }

  state.setStatus({ lastTickAt: Date.now() }); // 心跳，供 /api/status 判活
}

async function loop() {
  try { await tick(); }
  catch (e) { state.log(`tick 异常：${(e && e.message) || e}`); }
  finally { timer = setTimeout(loop, TICK_MS); } // 无论如何都排下一轮，杜绝调度永久停摆
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

module.exports = { start, tick, setPaused, testBird, testTelegram };
