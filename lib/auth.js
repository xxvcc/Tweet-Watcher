'use strict';
// 认证：bcrypt 密码（兼容旧 $2y$ 哈希）、HMAC 签名的会话 Cookie、CSRF 双提交令牌。
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PASSWORD_INPUT_POLICY = 'utf8-72-v1';
const MAX_ACCEPTED_BCRYPT_COST = 14;
let stderrUsable = true;
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', () => { stderrUsable = false; });
}
function warn(message) {
  if (!stderrUsable) return;
  try { process.stderr.write(message); } catch (_) { stderrUsable = false; }
}

// session_secret（key/epoch）缓存在内存，避免每请求 2 次同步读盘阻塞事件循环。
// 只有 bumpEpoch 会改它，改时同步更新缓存。
let metaCache = null;
function validMeta(s) {
  return !!s
    && typeof s.key === 'string'
    && /^[0-9a-f]{64}$/.test(s.key)
    && Number.isSafeInteger(s.epoch)
    && s.epoch >= 1;
}
function getMeta() {
  if (metaCache) return metaCache;
  const r = store.readState('session_secret.json');
  if (r.status === 'corrupt') {
    // 损坏时不得不重建密钥（会使所有会话失效），但必须留痕而非静默
    warn('[auth] session_secret.json 损坏，将重建密钥（所有会话失效）\n');
  }
  let s = r.status === 'ok' ? r.value : null;
  let changed = false;
  if (!validMeta(s)) {
    if (r.status === 'ok') {
      warn('[auth] session_secret.json 结构非法，将重建密钥（所有会话失效）\n');
    }
    s = { key: crypto.randomBytes(32).toString('hex'), epoch: 1 };
    changed = true;
  }
  if (changed) store.writeJSON('session_secret.json', s);
  metaCache = s;
  return s;
}
function getServerSecret() { return getMeta().key; }
function getEpoch() { return getMeta().epoch; }
function sessionEpoch() { return getEpoch(); }
// 让所有已签发的会话立即失效（登出 / 改密时调用）。
// 先落盘再更新内存缓存：若反过来，写盘失败（磁盘满）时进程内会话已吊销，
// 但重启后 epoch 回退，旧会话 Cookie 会"复活"。
function bumpEpoch() {
  const s = getMeta();
  // 安全整数到顶时轮换 HMAC key 并重置 epoch；单纯 +1 会因浮点精度停止变化，无法再吊销会话。
  const next = s.epoch >= Number.MAX_SAFE_INTEGER
    ? { key: crypto.randomBytes(32).toString('hex'), epoch: 1 }
    : { ...s, epoch: s.epoch + 1 };
  store.writeJSON('session_secret.json', next);
  metaCache = next;
}

// —— 密码 ——
function hasPassword() {
  const r = store.readState('password.json');
  if (r.status === 'missing') return false;
  // fail-closed：文件只要存在，就视为已设置。即使它是合法 JSON 但结构损坏（如 {}），
  // 也不能重新开放无认证 setup；管理员须按密码重置流程显式删除该文件。
  return true;
}
function getPasswordRecord() {
  const p = store.readJSON('password.json', null);
  const hasPolicy = !!p && typeof p === 'object'
    && Object.prototype.hasOwnProperty.call(p, 'input_policy');
  const rawHash = p && typeof p.hash === 'string' ? normalizeHash(p.hash) : '';
  const hashMatch = /^\$2[ab]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(rawHash);
  const cost = hashMatch ? Number(hashMatch[1]) : NaN;
  return {
    // 本项目只生成 cost=12。给旧记录留出兼容余量，但拒绝 cost 15-31：
    // bcrypt 的工作量指数增长，篡改后的高 cost 哈希会让一次登录占用 CPU 数分钟甚至更久。
    hash: hashMatch && cost >= 4 && cost <= MAX_ACCEPTED_BCRYPT_COST ? rawHash : '',
    // 只有完全缺失字段才是可兼容的旧记录；未知/损坏的显式策略必须 fail-closed。
    inputPolicy: hasPolicy
      ? (p.input_policy === PASSWORD_INPUT_POLICY ? PASSWORD_INPUT_POLICY : 'invalid')
      : null,
  };
}
function normalizeHash(h) {
  // bcryptjs 对 $2y$ 前缀兼容性不稳，统一改写为 $2b$（同算法，仅版本标记不同）
  return typeof h === 'string' ? h.replace(/^\$2y\$/, '$2b$') : h;
}
function passwordError(pw) {
  const s = typeof pw === 'string' ? pw : '';
  if ([...s].length < 8) return '密码至少 8 位';
  // bcrypt 只使用 UTF-8 编码后的前 72 字节；拒绝更长输入，避免用户误以为后缀参与校验。
  if (Buffer.byteLength(s, 'utf8') > 72) return '密码不能超过 72 个 UTF-8 字节';
  return '';
}
async function hashPassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const invalid = passwordError(s);
  if (invalid) throw new RangeError(invalid);
  return bcrypt.hash(s, 12); // 异步，不阻塞事件循环
}
function savePasswordHash(hash) {
  // 该入口只接受本模块生成的固定 cost，避免未来调用方把任意高成本记录写入登录热路径。
  if (typeof hash !== 'string' || !/^\$2[ab]\$12\$[./A-Za-z0-9]{53}$/.test(hash)) {
    throw new TypeError('密码哈希格式非法');
  }
  store.writeJSON('password.json', { hash, input_policy: PASSWORD_INPUT_POLICY });
}
async function setPassword(pw) {
  savePasswordHash(await hashPassword(pw));
}
async function verifyPassword(pw) {
  const record = getPasswordRecord();
  const h = record.hash;
  if (!h) return false;
  const candidate = typeof pw === 'string' ? pw : '';
  const candidateBytes = Buffer.byteLength(candidate, 'utf8');
  if (record.inputPolicy === 'invalid') return false;
  // 只对带新策略标记的记录强制边界。旧版曾允许 >72B 密码；直接全局拒绝会锁死这些用户。
  if (record.inputPolicy === PASSWORD_INPUT_POLICY && candidateBytes > 72) return false;
  try {
    const ok = await bcrypt.compare(candidate, h); // 异步，避免同步 compareSync 阻塞
    if (ok && !record.inputPolicy && candidateBytes <= 72) {
      // 成功使用短候选的旧记录可无损升级。写前重新核对 hash，不能覆盖 bcrypt 期间完成的改密。
      try {
        const current = getPasswordRecord();
        if (current.hash === record.hash && !current.inputPolicy) {
          store.writeJSON('password.json', { hash: record.hash, input_policy: PASSWORD_INPUT_POLICY });
        }
      } catch (_) { /* 元数据升级失败不应阻止一次已验证的登录 */ }
    }
    return ok;
  } catch (_) { return false; }
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
    if (!p || p.a !== 1 || p.e !== getEpoch() || !Number.isSafeInteger(p.iat) || p.iat < 0) return false;
    const age = Date.now() - p.iat;
    // 允许小幅 NTP 校时，但系统时钟大幅回拨时必须让会话失效，而不是把 7 天有效期延长数月/数年。
    return age >= -SESSION_CLOCK_SKEW_MS && age < SESSION_TTL_MS;
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
  hasPassword, passwordError, hashPassword, savePasswordHash, setPassword, verifyPassword,
  makeSession, verifySession, sessionEpoch, bumpEpoch, makeCsrf, checkCsrf,
};
