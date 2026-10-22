'use strict';
// One atomic record owns both captured messages and delivery acknowledgements. A failed
// commit stops delivery; its candidate stays in memory for retry without losing the batch.
const FILE = 'delivery_state.json';
const MARKER = 'delivery_state.initialized.json';
const MAX_PENDING_ACCOUNT = 1000;
const MAX_PENDING_TOTAL = 5000;
const MAX_BYTES = 6 * 1024 * 1024; // below store's 8 MiB read limit, including pretty JSON
const ID = /^\d{1,32}$/;
const USER = /^[A-Za-z0-9_]{1,15}$/;
const BINDING = /^[a-f0-9]{64}$/;
const TEXT_LIMITS = { text: 12000, time: 256, url: 2048, name: 160 };

function dataError(detail) {
  const error = new Error(`${FILE} 损坏或缺失，已停止推送并保留原文件`);
  error.code = 'DATA_CORRUPT';
  error.cause = detail;
  return error;
}
function highest(ids) {
  let high = null;
  for (const id of ids) if (high === null || BigInt(id) > BigInt(high)) high = id;
  return high;
}
function normalizeLegacyIds(ids, maxSent) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > maxSent * 2) return null;
  const result = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim()
      : (typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : '');
    if (!ID.test(id)) return null;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}
function normalizeTweet(tweet) {
  if (!tweet || typeof tweet !== 'object' || typeof tweet.id !== 'string' || !ID.test(tweet.id)) {
    throw new Error('待发送推文 ID 无效');
  }
  const value = { id: tweet.id };
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    const text = tweet[key] === undefined ? '' : tweet[key];
    if (typeof text !== 'string' || text.length > limit) throw new Error('待发送推文内容超过限制或无效');
    value[key] = text;
  }
  value.is_rt = tweet.is_rt === true;
  return value;
}
function validate(doc, maxSent) {
  if (!doc || doc.version !== 1 || !doc.accounts || typeof doc.accounts !== 'object'
      || Array.isArray(doc.accounts) || Object.keys(doc.accounts).length > 100) throw dataError();
  let pendingCount = 0;
  for (const [user, record] of Object.entries(doc.accounts)) {
    if (!USER.test(user) || user !== user.toLowerCase() || !record
        || typeof record !== 'object' || Array.isArray(record)) throw dataError();
    if (record.sent !== null && (!Array.isArray(record.sent) || record.sent.length === 0
        || record.sent.length > maxSent || record.sent.some((id) => typeof id !== 'string' || !ID.test(id))
        || new Set(record.sent).size !== record.sent.length)) throw dataError();
    if (record.watermark !== null && (typeof record.watermark !== 'string' || !ID.test(record.watermark))) throw dataError();
    if ((record.sent === null) !== (record.watermark === null)) throw dataError();
    if (record.sent && record.sent.some((id) => BigInt(id) > BigInt(record.watermark))) throw dataError();
    if (!Array.isArray(record.pending) || record.pending.length > MAX_PENDING_ACCOUNT) throw dataError();
    if (record.destination !== null && (typeof record.destination !== 'string' || !BINDING.test(record.destination))) throw dataError();
    if (record.pending.length && (!record.destination || !record.watermark)) throw dataError();
    if (record.gap !== null && (!record.gap || typeof record.gap.after !== 'string'
        || typeof record.gap.before !== 'string' || !ID.test(record.gap.after) || !ID.test(record.gap.before)
        || BigInt(record.gap.after) > BigInt(record.gap.before))) throw dataError();
    const seen = new Set();
    let previous = null;
    for (const tweet of record.pending) {
      const normalized = normalizeTweet(tweet);
      if (typeof tweet.is_rt !== 'boolean'
          || Object.keys(TEXT_LIMITS).some((key) => typeof tweet[key] !== 'string')
          || (previous !== null && BigInt(tweet.id) <= previous)) throw dataError();
      previous = BigInt(tweet.id);
      if (seen.has(normalized.id) || record.sent.includes(normalized.id)
          || BigInt(normalized.id) > BigInt(record.watermark)) throw dataError();
      seen.add(normalized.id);
    }
    pendingCount += record.pending.length;
  }
  if (pendingCount > MAX_PENDING_TOTAL || Buffer.byteLength(JSON.stringify(doc, null, 2)) > MAX_BYTES) {
    const error = new Error('待发送队列已达容量上限；已保留原队列且未推进抓取水位，请恢复推送或处理积压');
    error.code = 'OUTBOX_FULL';
    throw error;
  }
}

function createOutbox(store, maxSent) {
  let current = null;
  let committed = false;
  let initialized = false;
  let candidate = null;
  function read(name) {
    return store.readState(name);
  }
  function checkMarker() {
    const marker = read(MARKER);
    if (marker.status === 'corrupt' || (initialized && marker.status !== 'ok')) throw dataError(marker.error);
    if (marker.status === 'ok') {
      if (!marker.value || marker.value.version !== 1 || Array.isArray(marker.value)) throw dataError();
      initialized = true;
    }
  }
  function load() {
    if (current) return;
    checkMarker();
    const saved = read(FILE);
    if (initialized && saved.status !== 'ok') throw dataError(saved.error);
    if (saved.status === 'corrupt') throw dataError(saved.error);
    if (saved.status === 'ok') {
      try { validate(saved.value, maxSent); } catch (e) { throw dataError(e); }
      current = saved.value;
      committed = true;
      return;
    }
    const legacy = read('sent_ids.json');
    if (legacy.status === 'corrupt') throw dataError(legacy.error);
    const accounts = Object.create(null);
    if (legacy.status === 'ok' && legacy.value && typeof legacy.value === 'object' && !Array.isArray(legacy.value)) {
      for (const [user, ids] of Object.entries(legacy.value)) {
        if (!USER.test(user)) continue;
        const key = user.toLowerCase();
        const legacySent = normalizeLegacyIds(ids, maxSent);
        const prior = accounts[key];
        // Old releases may have retained multiple casing variants. They contain only
        // acknowledged IDs, so merging them cannot redirect or discard pending text.
        const all = [...new Set([...(prior && prior.sent || []), ...(legacySent || [])])];
        const sent = all.length ? all.slice(-maxSent) : null;
        const watermark = all.length ? highest([...(prior && prior.watermark ? [prior.watermark] : []), ...all]) : null;
        accounts[key] = { sent, watermark, pending: [], destination: null, gap: null };
      }
    }
    current = { version: 1, accounts };
    validate(current, maxSent);
  }
  function checkDisk() {
    checkMarker();
    const saved = read(FILE);
    if (saved.status === 'corrupt' || ((committed || initialized) && saved.status !== 'ok')) throw dataError(saved.error);
    if (saved.status === 'ok') {
      try { validate(saved.value, maxSent); } catch (e) { throw dataError(e); }
    }
  }
  function commit(next) {
    // Validate before accepting the candidate: a full queue must preserve the previous record.
    validate(next, maxSent);
    candidate = next;
    flush();
  }
  function flush() {
    load();
    checkDisk();
    try {
      if (candidate) {
        store.writeJSON(FILE, candidate);
        current = candidate;
        candidate = null;
        committed = true;
      }
      // State must precede its durable marker. A crash between these writes is safe:
      // the complete state is loaded and the marker is retried before any send.
      // Once marked, a missing state can never masquerade as a legacy migration.
      if (committed && !initialized) {
        store.writeJSON(MARKER, { version: 1 });
        initialized = true;
      }
    } catch (cause) {
      const error = new Error('待发送队列保存失败，已停止推送；恢复磁盘写入后自动重试');
      error.code = 'OUTBOX_WRITE';
      error.cause = cause;
      throw error;
    }
  }
  function get(user) {
    load();
    const key = user.toLowerCase();
    return Object.prototype.hasOwnProperty.call(current.accounts, key) ? current.accounts[key] : null;
  }
  function save(user, record) {
    load();
    if (candidate || (committed && !initialized)) throw new Error('待发送队列仍有未落盘事务，已停止推送');
    commit({ version: 1, accounts: { ...current.accounts, [user.toLowerCase()]: record } });
  }
  return {
    flush,
    get,
    ready() { return candidate === null && (!committed || initialized); },
    initialize() {
      // The worker calls this only after a saved config has selected the active
      // accounts. Persist the imported snapshot without changing its watermarks.
      flush();
      if (!committed) commit(current);
    },
    prune(active) {
      load();
      const keys = new Set([...active].map((user) => user.toLowerCase()));
      const accounts = Object.fromEntries(Object.entries(current.accounts).filter(([user]) => keys.has(user)));
      if (Object.keys(accounts).length !== Object.keys(current.accounts).length) commit({ version: 1, accounts });
    },
    baseline(user, ids) {
      const unique = [...new Set(ids)];
      const sent = unique.slice(-maxSent);
      save(user, { sent, watermark: highest(unique), pending: [], destination: null, gap: null });
    },
    capture(user, tweets, destination, gap) {
      const prior = get(user);
      if (!prior || prior.sent === null) throw new Error('尚未建立抓取基线');
      if (prior.pending.length && prior.destination !== destination) throw new Error('待发送队列目标与当前 Telegram 配置不一致');
      const additions = tweets.map(normalizeTweet);
      const pending = prior.pending.concat(additions);
      if (pending.length > MAX_PENDING_ACCOUNT) {
        const error = new Error('该账号待发送队列已达容量上限；已保留原队列且未推进抓取水位，请恢复推送或处理积压');
        error.code = 'OUTBOX_FULL';
        throw error;
      }
      if (!additions.length && !gap) return;
      save(user, {
        ...prior, pending,
        destination: pending.length ? destination : null,
        watermark: highest([prior.watermark, ...additions.map((tweet) => tweet.id)]),
        gap: prior.gap || gap || null,
      });
    },
    acknowledge(user, id, visibleIds) {
      const prior = get(user);
      if (!prior || !prior.pending.some((tweet) => tweet.id === id)) throw new Error('待发送队列确认不匹配');
      const visible = new Set(visibleIds);
      const uniq = [...new Set([...prior.sent, id])];
      const keep = uniq.filter((sentId) => visible.has(sentId)).slice(-maxSent);
      const rest = uniq.filter((sentId) => !visible.has(sentId));
      const room = Math.max(0, maxSent - keep.length);
      const sent = (room ? rest.slice(-room) : []).concat(keep);
      const pending = prior.pending.filter((tweet) => tweet.id !== id);
      save(user, { ...prior, sent, pending, destination: pending.length ? prior.destination : null });
    },
  };
}

module.exports = { createOutbox, MAX_PENDING_ACCOUNT, MAX_PENDING_TOTAL, MAX_BYTES };
