'use strict';
// 调度 worker：按账号间隔拉取、去重、重试推送。与面板同进程，单线程顺序执行，无并发竞态。
const store = require('./store');
const cfgmod = require('./config');
const bird = require('./bird');
const tg = require('./telegram');
const state = require('./state');

const TICK_MS = 5000;

let sentIds = {};        // 内存里持有的去重表（单进程唯一真源）
const lastCheck = {};    // username -> ts(ms)
let timer = null;
let running = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSent() { sentIds = store.readJSON('sent_ids.json', {}) || {}; }
function saveSent() { store.writeJSON('sent_ids.json', sentIds); }

// 从日志字符串里抹掉可能被 bird/错误输出带出的凭据值
function redact(s, secrets) {
  let out = String(s == null ? '' : s);
  for (const v of [secrets.auth_token, secrets.ct0, secrets.tg_bot_token]) {
    if (v && v.length > 6) out = out.split(v).join('***');
  }
  return out;
}

async function checkAccount(acct, cfg, secrets) {
  const user = acct.username;
  state.setAccount(user, { checking: true });
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
    sentIds[user] = tweets.map((t) => String(t.id));
    saveSent();
    state.log(`@${user} 首次运行，记录 ${tweets.length} 条推文 ID，不推送`);
    state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: 0 });
    return;
  }

  const known = new Set(Array.isArray(sentIds[user]) ? sentIds[user] : []);
  const fresh = tweets.filter((t) => !known.has(String(t.id))).reverse();
  if (fresh.length === 0) {
    state.log(`@${user} 无新推文`);
    state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: 0 });
    return;
  }

  let pushed = 0;
  for (const t of fresh) {
    const text = tg.formatTweet(t, user);
    let ok = false;
    for (let r = 0; r < 3 && !ok; r++) {
      if (r > 0) { state.log(`↻ 重试 @${user}: ${t.id}`); await sleep(2000); }
      const send = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text });
      ok = send.ok;
      if (!ok && r === 2) state.log(`  Telegram: ${send.description || '发送失败'}`);
    }
    if (ok) {
      pushed++;
      if (!Array.isArray(sentIds[user])) sentIds[user] = [];
      sentIds[user].push(String(t.id));
      saveSent(); // 每条推成功后立即落盘，避免崩溃后重推
      state.log(`✓ 推送 @${user}: ${t.id}`);
    } else {
      state.log(`✗ 推送失败 @${user}: ${t.id}`);
    }
    await sleep(500);
  }

  if (sentIds[user].length > cfgmod.LIMITS.MAX_SENT) {
    sentIds[user] = sentIds[user].slice(-cfgmod.LIMITS.MAX_SENT);
  }
  saveSent();
  state.setAccount(user, { checking: false, lastCheck: Date.now(), ok: true, lastError: null, lastPushed: pushed });
}

async function tick() {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  state.setStatus({ paused: !!cfg.paused });

  // 清理已删除账号的去重记录/计时/状态
  const active = cfg.accounts.map((a) => a.username);
  const activeSet = new Set(active);
  let sentChanged = false;
  for (const u of Object.keys(sentIds)) if (!activeSet.has(u)) { delete sentIds[u]; sentChanged = true; }
  for (const u of Object.keys(lastCheck)) if (!activeSet.has(u)) delete lastCheck[u];
  if (sentChanged) saveSent();
  state.pruneAccounts(active);

  if (cfg.paused) return;

  const now = Date.now();
  for (const acct of cfg.accounts) {
    if (now - (lastCheck[acct.username] || 0) >= acct.check_interval * 1000) {
      lastCheck[acct.username] = Date.now();
      try { await checkAccount(acct, cfg, secrets); }
      catch (e) { state.log(`检查 @${acct.username} 异常：${e.message}`); }
    }
  }
}

async function loop() {
  try { await tick(); } catch (e) { state.log(`tick 异常：${e.message}`); }
  timer = setTimeout(loop, TICK_MS);
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
  if (!res.ok) return { ok: false, message: res.error || res.raw || '拉取失败' };
  const t = res.tweets[0];
  return { ok: true, message: t ? `拉取 @${user} 成功，最新推文：${(t.text || '').slice(0, 80)}` : `@${user} 无推文，但连接正常` };
}

async function testTelegram() {
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const r = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text: '🐦 Tweet Watcher 测试消息 — 配置正确！' });
  return { ok: r.ok, message: r.ok ? 'Telegram 测试消息已发送' : ('发送失败：' + (r.description || '')) };
}

// 当账号被删除时，同步清掉内存去重（保存交给下一 tick）
function forgetAccount(user) { delete sentIds[user]; delete lastCheck[user]; }

module.exports = { start, tick, testBird, testTelegram, forgetAccount };
