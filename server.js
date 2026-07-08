'use strict';
// Tweet Watcher —— 单进程：既是网页面板，又是监控 worker。
const path = require('path');
const express = require('express');
const cfgmod = require('./lib/config');
const auth = require('./lib/auth');
const state = require('./lib/state');
const worker = require('./lib/worker');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
// 只信任本机 nginx（回环），避免客户端伪造 X-Forwarded-For 冒充 req.ip 绕过登录限流
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// —— cookie 解析（无第三方依赖）——
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});

function cookieSecure(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
function setAuthCookies(req, res) {
  const secure = cookieSecure(req);
  const maxAge = 7 * 24 * 3600 * 1000;
  res.cookie('tw_sess', auth.makeSession(), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge });
  res.cookie('tw_csrf', auth.makeCsrf(), { httpOnly: false, sameSite: 'lax', secure, path: '/', maxAge });
}
function requireAuth(req, res, next) {
  if (auth.verifySession(req.cookies.tw_sess)) return next();
  res.status(401).json({ ok: false, error: '未登录' });
}
function requireCsrf(req, res, next) {
  if (auth.checkCsrf(req.cookies.tw_csrf, req.headers['x-csrf'])) return next();
  res.status(403).json({ ok: false, error: 'CSRF 校验失败' });
}

// —— 登录限流（内存，按 IP）——
const loginFails = new Map();
function loginBlockedMinutes(ip) {
  const r = loginFails.get(ip);
  if (!r || r.count < 5) return null;
  const lock = r.count >= 20 ? 3600e3 : r.count >= 10 ? 1800e3 : 300e3;
  const rem = lock - (Date.now() - r.last);
  return rem > 0 ? Math.ceil(rem / 60000) : null;
}
function recordFail(ip) {
  const now = Date.now();
  if (loginFails.size > 1000) { for (const [k, r] of loginFails) if (now - r.last > 3600e3) loginFails.delete(k); }
  const r = loginFails.get(ip) || { count: 0, last: 0 }; r.count++; r.last = now; loginFails.set(ip, r);
}

// ===== 认证相关 =====
app.get('/api/session', (req, res) => {
  res.json({ hasPassword: auth.hasPassword(), authed: auth.verifySession(req.cookies.tw_sess) });
});
app.post('/api/setup', (req, res) => {
  if (auth.hasPassword()) return res.status(400).json({ ok: false, error: '已设置过密码' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 8) return res.status(400).json({ ok: false, error: '密码至少 8 位' });
  auth.setPassword(pw);
  setAuthCookies(req, res);
  res.json({ ok: true });
});
app.post('/api/login', async (req, res) => {
  // X-Real-IP 由 nginx 无条件覆盖为真实连接 IP，客户端无法伪造；回退到 req.ip
  const ip = req.headers['x-real-ip'] || req.ip || 'unknown';
  const blk = loginBlockedMinutes(ip);
  if (blk) return res.status(429).json({ ok: false, error: `尝试过多，请 ${blk} 分钟后再试` });
  const pw = String((req.body && req.body.password) || '');
  if (auth.verifyPassword(pw)) { loginFails.delete(ip); setAuthCookies(req, res); return res.json({ ok: true }); }
  await new Promise((r) => setTimeout(r, 1000));
  recordFail(ip);
  res.status(401).json({ ok: false, error: '密码错误' });
});
app.post('/api/logout', (req, res) => {
  auth.bumpEpoch(); // 使所有已签发会话立即失效（单用户工具）
  res.clearCookie('tw_sess', { path: '/' });
  res.clearCookie('tw_csrf', { path: '/' });
  res.json({ ok: true });
});
app.post('/api/password', requireAuth, requireCsrf, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!auth.verifyPassword(String(old_password || ''))) return res.status(400).json({ ok: false, error: '当前密码错误' });
  if (String(new_password || '').length < 8) return res.status(400).json({ ok: false, error: '新密码至少 8 位' });
  auth.setPassword(String(new_password));
  auth.bumpEpoch();          // 改密后旧会话立即失效
  setAuthCookies(req, res);  // 给当前用户换发新会话，避免被自己登出
  res.json({ ok: true });
});

// ===== 配置 =====
app.get('/api/config', requireAuth, (req, res) => {
  const cfg = cfgmod.getConfig();
  const s = cfgmod.getSecrets();
  res.json({
    bird_path: cfg.bird_path, tg_chat_id: cfg.tg_chat_id, accounts: cfg.accounts,
    secrets: { hasAuthToken: !!s.auth_token, hasCt0: !!s.ct0, hasTgBotToken: !!s.tg_bot_token },
  });
});
app.post('/api/config', requireAuth, requireCsrf, (req, res) => {
  const b = req.body || {};
  const cur = cfgmod.getConfig();
  const accounts = cfgmod.normalizeAccounts(b.accounts);
  cfgmod.saveConfig({
    bird_path: cfgmod.validBirdPath(b.bird_path) ? b.bird_path : cur.bird_path,
    tg_chat_id: cfgmod.validChatId(b.tg_chat_id) ? String(b.tg_chat_id || '') : cur.tg_chat_id,
    paused: cur.paused,
    accounts,
  });
  const sec = cfgmod.getSecrets();
  const ns = { ...sec };
  if (typeof b.auth_token === 'string' && b.auth_token.trim()) ns.auth_token = b.auth_token.trim();
  if (typeof b.ct0 === 'string' && b.ct0.trim()) ns.ct0 = b.ct0.trim();
  if (typeof b.tg_bot_token === 'string' && b.tg_bot_token.trim()) ns.tg_bot_token = b.tg_bot_token.trim();
  cfgmod.saveSecrets(ns);
  res.json({ ok: true, accounts });
});

// ===== 状态 / 日志 / 控制 / 测试 =====
app.get('/api/status', requireAuth, (req, res) => {
  const cfg = cfgmod.getConfig();
  res.json({ status: state.getStatus(), paused: cfg.paused, accounts: cfg.accounts });
});
app.get('/api/logs', requireAuth, (req, res) => { res.json({ logs: state.getLogs(200) }); });

app.post('/api/control', requireAuth, requireCsrf, (req, res) => {
  const action = req.body && req.body.action;
  const cfg = cfgmod.getConfig();
  if (action === 'pause') cfg.paused = true;
  else if (action === 'resume') cfg.paused = false;
  else return res.status(400).json({ ok: false, error: '未知操作' });
  cfgmod.saveConfig(cfg);
  state.setStatus({ paused: cfg.paused });
  state.log(cfg.paused ? '监控已暂停' : '监控已恢复');
  res.json({ ok: true, paused: cfg.paused });
});
app.post('/api/test/bird', requireAuth, requireCsrf, async (req, res) => {
  const r = await worker.testBird((req.body && req.body.username) || '');
  res.json(r);
});
app.post('/api/test/telegram', requireAuth, requireCsrf, async (req, res) => {
  const r = await worker.testTelegram();
  res.json(r);
});

// ===== SSE 实时流（状态 + 日志）=====
app.get('/api/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('status', state.getStatus());
  for (const l of state.getLogs(50)) send('log', l);
  const onStatus = (s) => send('status', s);
  const onLog = (l) => send('log', l);
  state.bus.on('status', onStatus);
  state.bus.on('log', onLog);
  const ka = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); state.bus.off('status', onStatus); state.bus.off('log', onLog); });
});

// ===== 静态面板 =====
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 兜底：单进程同时承载面板与 worker，别让一个游离的异常拖垮整个服务
process.on('unhandledRejection', (e) => state.log('未处理的 Promise 拒绝：' + ((e && e.message) || e)));
process.on('uncaughtException', (e) => state.log('未捕获异常：' + ((e && e.stack) || e)));

app.listen(PORT, HOST, () => {
  state.log(`面板/服务已监听 http://${HOST}:${PORT}`);
  worker.start();
});
