'use strict';
// Tweet Watcher —— 单进程：既是网页面板，又是监控 worker。
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cfgmod = require('./lib/config');
const store = require('./lib/store');
const auth = require('./lib/auth');
const state = require('./lib/state');
const worker = require('./lib/worker');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
// 只信任本机 nginx（回环），避免客户端伪造 X-Forwarded-For 冒充 req.ip 绕过登录限流
app.set('trust proxy', 'loopback');

// —— 统一安全响应头 ——
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 脚本严格同源（无 unsafe-inline）；样式放行内联属性以兼容 index.html 现有 style="…"
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// —— cookie 解析（无第三方依赖）——
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      let v = part.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch (_) { /* 畸形百分号编码：保留原值，不让单个坏 Cookie 使整请求 500 */ }
      req.cookies[k] = v;
    }
  }
  next();
});

// async 路由包装：把 rejected promise 交给统一错误中间件，避免 Express4 下请求永久挂起
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// —— 首次设置令牌：无密码时于启动打印，/api/setup 须携带它，杜绝无认证首次抢注(TOFU) ——
let setupToken = null;
function refreshSetupToken() {
  if (!auth.hasPassword()) {
    if (!setupToken) {
      setupToken = crypto.randomBytes(24).toString('hex');
      state.log(`⚙ 首次设置令牌（用于 /api/setup，仅本进程有效）：${setupToken}`);
    }
  } else {
    setupToken = null;
  }
}
function checkSetupToken(v) {
  if (!setupToken || !v) return false;
  try {
    const a = Buffer.from(String(v)), b = Buffer.from(setupToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

// —— 登录限流（内存，按 IP）——
const loginFails = new Map();
const LOGIN_MAX_ENTRIES = 5000;
function pruneLoginFails(now) {
  for (const [k, r] of loginFails) if (now - r.last > 3600e3) loginFails.delete(k); // 每次写入惰性回收过期项
  if (loginFails.size > LOGIN_MAX_ENTRIES) { // 硬上限：仍超限则淘汰最旧，杜绝无界增长
    const sorted = [...loginFails.entries()].sort((a, b) => a[1].last - b[1].last);
    for (let i = 0; i < sorted.length && loginFails.size > LOGIN_MAX_ENTRIES; i++) loginFails.delete(sorted[i][0]);
  }
}
function loginBlockedMinutes(ip) {
  const r = loginFails.get(ip);
  if (!r || r.count < 5) return null;
  const lock = r.count >= 20 ? 3600e3 : r.count >= 10 ? 1800e3 : 300e3;
  const rem = lock - (Date.now() - r.last);
  if (rem <= 0) { loginFails.delete(ip); return null; } // 锁定期满即清零，避免历史失败对合法用户造成持久锁
  return Math.ceil(rem / 60000);
}
function recordFail(ip) {
  const now = Date.now();
  pruneLoginFails(now);
  const r = loginFails.get(ip) || { count: 0, last: 0 };
  r.count++; r.last = now; loginFails.set(ip, r);
}

// ===== 认证相关 =====
app.get('/api/session', (req, res) => {
  res.json({ hasPassword: auth.hasPassword(), authed: auth.verifySession(req.cookies.tw_sess) });
});
app.post('/api/setup', wrap(async (req, res) => {
  if (auth.hasPassword()) return res.status(400).json({ ok: false, error: '已设置过密码' });
  const token = (req.body && req.body.setup_token) || req.headers['x-setup-token'] || '';
  if (!checkSetupToken(token)) return res.status(403).json({ ok: false, error: '首次设置令牌无效，请查看服务端日志获取' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 8) return res.status(400).json({ ok: false, error: '密码至少 8 位' });
  await auth.setPassword(pw);
  setupToken = null;
  setAuthCookies(req, res);
  res.json({ ok: true });
}));
app.post('/api/login', wrap(async (req, res) => {
  // trust proxy=loopback 已保证 req.ip 为 nginx 传入的真实客户端 IP，外部无法伪造；不再读业务层 x-real-ip
  const ip = req.ip || 'unknown';
  const blk = loginBlockedMinutes(ip);
  if (blk) return res.status(429).json({ ok: false, error: `尝试过多，请 ${blk} 分钟后再试` });
  const pw = String((req.body && req.body.password) || '');
  // 先同步记账再校验：与闸门判定处于同一同步临界区（其间无 await），杜绝"并发请求在自增前全部放行"的绕过
  recordFail(ip);
  if (await auth.verifyPassword(pw)) { loginFails.delete(ip); setAuthCookies(req, res); return res.json({ ok: true }); }
  await new Promise((r) => setTimeout(r, 1000));
  res.status(401).json({ ok: false, error: '密码错误' });
}));
app.post('/api/logout', (req, res) => {
  // 仅在持有有效会话 + CSRF 时才全局吊销(bumpEpoch)，否则任意未认证请求可借此制造全局登出 DoS。
  // 无论是否认证都清掉本请求的 Cookie（即便会话已过期也能正常登出）。
  if (auth.verifySession(req.cookies.tw_sess) && auth.checkCsrf(req.cookies.tw_csrf, req.headers['x-csrf'])) {
    auth.bumpEpoch();
  }
  res.clearCookie('tw_sess', { path: '/' });
  res.clearCookie('tw_csrf', { path: '/' });
  res.json({ ok: true });
});
app.post('/api/password', requireAuth, requireCsrf, wrap(async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!(await auth.verifyPassword(String(old_password || '')))) return res.status(400).json({ ok: false, error: '当前密码错误' });
  if (String(new_password || '').length < 8) return res.status(400).json({ ok: false, error: '新密码至少 8 位' });
  await auth.setPassword(String(new_password));
  auth.bumpEpoch();          // 改密后旧会话立即失效
  setAuthCookies(req, res);  // 给当前用户换发新会话，避免被自己登出
  res.json({ ok: true });
}));

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
  const warnings = [];
  const accounts = cfgmod.normalizeAccounts(b.accounts);
  if (Array.isArray(b.accounts) && accounts.length < b.accounts.length) {
    warnings.push(`部分账号被忽略（非法用户名/重复/超出上限 ${cfgmod.LIMITS.MAX_ACCOUNTS}）`);
  }
  let bird_path = cur.bird_path;
  if (typeof b.bird_path === 'string' && b.bird_path.trim()) {
    const bp = b.bird_path.trim();
    if (cfgmod.validBirdPath(bp)) bird_path = bp;
    else warnings.push('bird 路径非法（须为绝对路径且文件名为 bird），已保留原值');
  }
  let tg_chat_id = cur.tg_chat_id;
  if (b.tg_chat_id !== undefined) {
    const v = String(b.tg_chat_id).trim();
    if (cfgmod.validChatId(v)) tg_chat_id = v;
    else warnings.push('Telegram Chat ID 非法（须为整数），已保留原值');
  }
  cfgmod.saveConfig({ bird_path, tg_chat_id, paused: cur.paused, accounts });
  const sec = cfgmod.getSecrets();
  const ns = { ...sec };
  if (typeof b.auth_token === 'string' && b.auth_token.trim()) ns.auth_token = b.auth_token.trim();
  if (typeof b.ct0 === 'string' && b.ct0.trim()) ns.ct0 = b.ct0.trim();
  if (typeof b.tg_bot_token === 'string' && b.tg_bot_token.trim()) ns.tg_bot_token = b.tg_bot_token.trim();
  cfgmod.saveSecrets(ns);
  // 回传服务端最终采用的值，便于前端核对被静默保留的字段
  res.json({ ok: true, accounts, bird_path, tg_chat_id, warnings });
});

// ===== 状态 / 日志 / 控制 / 测试 =====
app.get('/api/status', requireAuth, (req, res) => {
  const cfg = cfgmod.getConfig();
  const st = state.getStatus();
  const healthy = st.running && st.lastTickAt != null && (Date.now() - st.lastTickAt) < 60000;
  res.json({ status: st, paused: cfg.paused, accounts: cfg.accounts, healthy });
});
app.get('/api/logs', requireAuth, (req, res) => { res.json({ logs: state.getLogs(200) }); });

app.post('/api/control', requireAuth, requireCsrf, (req, res) => {
  const action = req.body && req.body.action;
  const cfg = cfgmod.getConfig();
  if (action === 'pause') cfg.paused = true;
  else if (action === 'resume') cfg.paused = false;
  else return res.status(400).json({ ok: false, error: '未知操作' });
  cfgmod.saveConfig(cfg);
  worker.setPaused(cfg.paused); // 即时生效，不必等下一 tick 读盘
  state.setStatus({ paused: cfg.paused });
  state.log(cfg.paused ? '监控已暂停' : '监控已恢复');
  res.json({ ok: true, paused: cfg.paused });
});

// test 端点：单飞，防止认证后并发派生大量子进程/出站请求（子进程风暴）
let birdTestInFlight = false;
let tgTestInFlight = false;
app.post('/api/test/bird', requireAuth, requireCsrf, wrap(async (req, res) => {
  if (birdTestInFlight) return res.status(429).json({ ok: false, message: '上一次测试仍在进行，请稍候' });
  birdTestInFlight = true;
  try { res.json(await worker.testBird((req.body && req.body.username) || '')); }
  finally { birdTestInFlight = false; }
}));
app.post('/api/test/telegram', requireAuth, requireCsrf, wrap(async (req, res) => {
  if (tgTestInFlight) return res.status(429).json({ ok: false, message: '上一次测试仍在进行，请稍候' });
  tgTestInFlight = true;
  try { res.json(await worker.testTelegram()); }
  finally { tgTestInFlight = false; }
}));

// ===== SSE 实时流（状态 + 日志）=====
let sseCount = 0;
const SSE_MAX = 25;
app.get('/api/stream', requireAuth, (req, res) => {
  if (sseCount >= SSE_MAX) return res.status(503).end(); // 连接数上限，防 fd/内存耗尽
  sseCount++;
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
  let closed = false;
  const cleanup = () => { if (closed) return; closed = true; clearInterval(ka); state.bus.off('status', onStatus); state.bus.off('log', onLog); sseCount--; };
  const ka = setInterval(() => {
    // 会话被登出/改密/过期后主动断流，避免向已吊销会话持续推送
    if (!auth.verifySession(req.cookies.tw_sess)) { cleanup(); try { res.end(); } catch (_) {} return; }
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);
  req.on('close', cleanup);
});

// ===== 静态面板 =====
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== 统一错误处理：绝不回传堆栈/绝对路径 =====
app.use((err, req, res, next) => {
  if (err && (err.status === 400 || err.statusCode === 400 || err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    if (!res.headersSent) return res.status(400).json({ ok: false, error: '请求无效' });
    return;
  }
  state.log(`请求处理异常：${(err && err.message) || err}`);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

// 兜底：进程遇到本应致命的错误时，记录后交给 systemd 干净重启，而非在未定义状态下带病续跑
let shuttingDown = false;
function fatal(kind, e) {
  try { state.log(`${kind}：${(e && e.stack) || e}`); } catch (_) {}
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 100);
}
process.on('unhandledRejection', (e) => fatal('未处理的 Promise 拒绝', e));
process.on('uncaughtException', (e) => fatal('未捕获异常', e));

app.listen(PORT, HOST, () => {
  store.sweepTmp();       // 清理原子写残留的孤儿 .tmp
  refreshSetupToken();    // 无密码时打印一次性首次设置令牌
  state.log(`面板/服务已监听 http://${HOST}:${PORT}`);
  worker.start();
});
