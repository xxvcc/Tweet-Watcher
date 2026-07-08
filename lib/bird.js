'use strict';
// 通过子进程调用 bird CLI 拉取推文并解析为统一结构。
const { execFile } = require('child_process');
const { validUsername } = require('./config');

function extractJSON(text) {
  const t = (text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (_) {}
  const fb = t.indexOf('['), lb = t.lastIndexOf(']');
  if (fb !== -1 && lb > fb) { try { return JSON.parse(t.slice(fb, lb + 1)); } catch (_) {} }
  const ob = t.indexOf('{'), obl = t.lastIndexOf('}');
  if (ob !== -1 && obl > ob) { try { return JSON.parse(t.slice(ob, obl + 1)); } catch (_) {} }
  return null;
}

function normalizeTweets(data, account) {
  let items = data;
  if (data && !Array.isArray(data)) items = data.tweets || data.results || data;
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const id = it.id ?? it.tweet_id ?? it.rest_id ?? null;
    if (id == null) continue;
    let name = it.author ?? (it.user && it.user.name) ?? it.name ?? account;
    if (name && typeof name === 'object') name = name.name || name.screen_name || name.username || account;
    out.push({
      id: String(id),
      text: String(it.text ?? it.full_text ?? it.content ?? ''),
      time: String(it.created_at ?? it.createdAt ?? it.time ?? it.date ?? it.published_at ?? ''),
      url: String(it.url ?? `https://x.com/${account}/status/${id}`),
      name: typeof name === 'string' ? name : account,
      is_rt: !!(it.is_retweet ?? it.retweeted_status),
    });
  }
  return out;
}

// 返回 { ok, tweets|null, error, raw }
function fetchTweets({ birdPath, username, count, authToken, ct0 }) {
  return new Promise((resolve) => {
    if (!validUsername(username)) return resolve({ ok: false, tweets: null, error: '账号名非法', raw: '' });
    if (!authToken || !ct0) return resolve({ ok: false, tweets: null, error: '缺少 auth_token / ct0', raw: '' });
    const n = Math.min(50, Math.max(1, parseInt(count, 10) || 1));
    const args = ['user-tweets', username, '--json', '-n', String(n),
      '--auth-token', authToken, '--ct0', ct0, '--no-color'];
    execFile(birdPath, args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = ((stdout || '') + (stderr ? '\n' + stderr : '')).trim();
      if (err && err.code === 'ENOENT') {
        return resolve({ ok: false, tweets: null, error: `bird 可执行文件不存在: ${birdPath}`, raw });
      }
      const data = extractJSON(raw);
      const tweets = normalizeTweets(data, username);
      if (tweets === null) {
        return resolve({ ok: false, tweets: null, error: err ? (err.killed ? 'bird 执行超时' : 'bird 执行失败') : 'bird 输出非 JSON', raw: raw.slice(0, 400) });
      }
      resolve({ ok: true, tweets, error: null, raw: '' });
    });
  });
}

module.exports = { fetchTweets, extractJSON, normalizeTweets };
