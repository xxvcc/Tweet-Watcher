'use strict';
// 配置（config.json）与敏感凭据（secrets.json）的读写与校验。
const store = require('./store');

const DEFAULT_BIRD = '/www/server/nodejs/v24.18.0/bin/bird';

const LIMITS = {
  MIN_INTERVAL: 30,
  MAX_INTERVAL: 3600,
  MAX_FETCH: 50,
  DEFAULT_FETCH: 10,
  DEFAULT_INTERVAL: 300,
  MAX_SENT: 200,
};

function validUsername(u) { return typeof u === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(u); }
function validBirdPath(p) { return typeof p === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(p) && !p.includes('..'); }
function validChatId(c) { return c === '' || /^-?\d+$/.test(String(c)); }
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeAccounts(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    const username = (typeof a === 'string' ? a : (a && a.username) || '').replace(/^@/, '').trim();
    if (!validUsername(username)) continue;
    out.push({
      username,
      fetch_count: clampInt(a && a.fetch_count, 1, LIMITS.MAX_FETCH, LIMITS.DEFAULT_FETCH),
      check_interval: clampInt(a && a.check_interval, LIMITS.MIN_INTERVAL, LIMITS.MAX_INTERVAL, LIMITS.DEFAULT_INTERVAL),
    });
  }
  return out;
}

function getConfig() {
  const raw = store.readJSON('config.json', {});
  return {
    bird_path: validBirdPath(raw.bird_path) ? raw.bird_path : DEFAULT_BIRD,
    tg_chat_id: validChatId(raw.tg_chat_id) ? String(raw.tg_chat_id || '') : '',
    paused: !!raw.paused,
    accounts: normalizeAccounts(raw.accounts),
  };
}

function saveConfig(cfg) { store.writeJSON('config.json', cfg); }

function getSecrets() {
  const s = store.readJSON('secrets.json', {});
  return {
    auth_token: String(s.auth_token || '').trim(),
    ct0: String(s.ct0 || '').trim(),
    tg_bot_token: String(s.tg_bot_token || '').trim(),
  };
}

function saveSecrets(s) { store.writeJSON('secrets.json', s); }

module.exports = {
  DEFAULT_BIRD, LIMITS,
  validUsername, validBirdPath, validChatId, clampInt, normalizeAccounts,
  getConfig, saveConfig, getSecrets, saveSecrets,
};
