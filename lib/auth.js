'use strict';
// 认证：bcrypt 密码（兼容旧 $2y$ 哈希）、HMAC 签名的会话 Cookie、CSRF 双提交令牌。
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

// session_secret（key/epoch）缓存在内存，避免每请求 2 次同步读盘阻塞事件循环。
// 只有 bumpEpoch 会改它，改时同步更新缓存。
let metaCache = null;
function getMeta() {
  if (metaCache) return metaCache;
  const r = store.readState('session_secret.json');
  if (r.status === 'corrupt') {
    // 损坏时不得不重建密钥（会使所有会话失效），但必须留痕而非静默
    try { process.stderr.write('[auth] session_secret.json 损坏，将重建密钥（所有会话失效）\n'); } catch (_) {}
  }
  let s = r.status === 'ok' ? r.value : null;
  let changed = false;
  if (!s || !s.key) { s = { key: crypto.randomBytes(32).toString('hex'), epoch: 1 }; changed = true; }
  if (!s.epoch) { s.epoch = 1; changed = true; }
  if (changed) store.writeJSON('session_secret.json', s);
  metaCache = s;
  return s;
}
function getServerSecret() { return getMeta().key; }
function getEpoch() { return getMeta().epoch; }
// 让所有已签发的会话立即失效（登出 / 改密时调用）。
// 先落盘再更新内存缓存：若反过来，写盘失败（磁盘满）时进程内会话已吊销，
// 但重启后 epoch 回退，旧会话 Cookie 会"复活"。
function bumpEpoch() {
  const s = getMeta();
  const next = { ...s, epoch: (s.epoch || 1) + 1 };
  store.writeJSON('session_secret.json', next);
  metaCache = next;
}

// —— 密码 ——
function hasPassword() {
  const r = store.readState('password.json');
  if (r.status === 'missing') return false;
  if (r.status === 'corrupt') return true; // fail-closed：损坏也视为"已设置"，绝不因损坏重开无认证 setup
  return !!(r.value && r.value.hash);
}
function getHash() {
  const p = store.readJSON('password.json', null);
  return p && p.hash ? String(p.hash) : '';
}
function normalizeHash(h) {
  // bcryptjs 对 $2y$ 前缀兼容性不稳，统一改写为 $2b$（同算法，仅版本标记不同）
  return typeof h === 'string' ? h.replace(/^\$2y\$/, '$2b$') : h;
}
async function setPassword(pw) {
  const hash = await bcrypt.hash(String(pw), 12); // 异步，不阻塞事件循环
  store.writeJSON('password.json', { hash });
}
async function verifyPassword(pw) {
  const h = normalizeHash(getHash());
  if (!h) return false;
  try { return await bcrypt.compare(String(pw), h); } catch (_) { return false; } // 异步，避免同步 compareSync 阻塞
}

// —— 会话 Cookie（无状态签名）——
function sign(payloadB64) {
  return crypto.createHmac('sha256', getServerSecret()).update(payloadB64).digest('base64url');
}
function makeSession() {
  const payload = { a: 1, iat: Date.now(), e: getEpoch() };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}
function verifySession(cookie) {
  if (!cookie || typeof cookie !== 'string' || !cookie.includes('.')) return false;
  const dot = cookie.indexOf('.');
  const b64 = cookie.slice(0, dot);
  const mac = cookie.slice(dot + 1); // 合法令牌恰有一个 '.'（b64 与签名均为 base64url，无点）
  try {
    const macBuf = Buffer.from(mac);
    const expBuf = Buffer.from(sign(b64));
    // 用字节长度判等再做恒定时间比较；畸形多字节 mac 会使两者字节长度不同，
    // 若不先判长度，timingSafeEqual 会抛 RangeError -> 冒泡成 500（本应 401）。
    if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return false;
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return p && p.a === 1 && p.e === getEpoch() && (Date.now() - p.iat) < SESSION_TTL_MS;
  } catch (_) { return false; }
}

// —— CSRF：双提交令牌 ——
function makeCsrf() { return crypto.randomBytes(24).toString('base64url'); }
function checkCsrf(cookieVal, headerVal) {
  if (!cookieVal || !headerVal) return false;
  try {
    const a = Buffer.from(String(cookieVal)), b = Buffer.from(String(headerVal));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

module.exports = {
  hasPassword, setPassword, verifyPassword,
  makeSession, verifySession, bumpEpoch, makeCsrf, checkCsrf,
};
