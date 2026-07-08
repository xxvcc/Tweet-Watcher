'use strict';
// 认证：bcrypt 密码（兼容旧 $2y$ 哈希）、HMAC 签名的会话 Cookie、CSRF 双提交令牌。
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function getMeta() {
  let s = store.readJSON('session_secret.json', null);
  let changed = false;
  if (!s || !s.key) { s = { key: crypto.randomBytes(32).toString('hex'), epoch: 1 }; changed = true; }
  if (!s.epoch) { s.epoch = 1; changed = true; }
  if (changed) store.writeJSON('session_secret.json', s);
  return s;
}
function getServerSecret() { return getMeta().key; }
function getEpoch() { return getMeta().epoch; }
// 让所有已签发的会话立即失效（登出 / 改密时调用）
function bumpEpoch() { const s = getMeta(); s.epoch = (s.epoch || 1) + 1; store.writeJSON('session_secret.json', s); }

// —— 密码 ——
function hasPassword() {
  const p = store.readJSON('password.json', null);
  return !!(p && p.hash);
}
function getHash() {
  const p = store.readJSON('password.json', null);
  return p && p.hash ? String(p.hash) : '';
}
function normalizeHash(h) {
  // bcryptjs 对 $2y$ 前缀兼容性不稳，统一改写为 $2b$（同算法，仅版本标记不同）
  return typeof h === 'string' ? h.replace(/^\$2y\$/, '$2b$') : h;
}
function setPassword(pw) {
  const hash = bcrypt.hashSync(String(pw), 12);
  store.writeJSON('password.json', { hash });
}
function setHashRaw(hash) { store.writeJSON('password.json', { hash: normalizeHash(hash) }); }
function verifyPassword(pw) {
  const h = normalizeHash(getHash());
  if (!h) return false;
  try { return bcrypt.compareSync(String(pw), h); } catch (_) { return false; }
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
  const [b64, mac] = cookie.split('.');
  const expect = sign(b64);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return false;
  try {
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return p && p.a === 1 && p.e === getEpoch() && (Date.now() - p.iat) < SESSION_TTL_MS;
  } catch (_) { return false; }
}

// —— CSRF：双提交令牌 ——
function makeCsrf() { return crypto.randomBytes(24).toString('base64url'); }
function checkCsrf(cookieVal, headerVal) {
  if (!cookieVal || !headerVal) return false;
  const a = Buffer.from(String(cookieVal)), b = Buffer.from(String(headerVal));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  hasPassword, setPassword, setHashRaw, verifyPassword,
  makeSession, verifySession, bumpEpoch, makeCsrf, checkCsrf,
};
