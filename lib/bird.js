'use strict';
// 通过子进程调用 bird CLI 拉取推文并解析为统一结构。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { validUsername, validBirdPath } = require('./config');

// 自动检测 bird 可执行文件：几个常见位置 + which bird，逐个用 --version 确认。
// 返回 { found, path, version }。只返回 basename 为 bird 的合法路径（可直接保存）。
function detectBird() {
  return new Promise((resolve) => {
    const candidates = [
      path.join(path.dirname(process.execPath), 'bird'), // 与运行中的 node 同目录（全局 npm 常装于此）
      '/usr/local/bin/bird',
      '/usr/bin/bird',
    ];
    execFile('which', ['bird'], { timeout: 5000 }, (e, out) => {
      if (!e && out) { const p = String(out).trim().split('\n')[0].trim(); if (p) candidates.unshift(p); }
      const seen = new Set();
      const list = candidates.filter((c) => {
        if (!c || seen.has(c)) return false; seen.add(c);
        try { return validBirdPath(c) && fs.existsSync(c); } catch (_) { return false; }
      });
      (function tryOne(i) {
        if (i >= list.length) return resolve({ found: false, path: null, version: null });
        execFile(list[i], ['--version'], { timeout: 8000 }, (err, so, se) => {
          if (!err) {
            const version = String(so || se || '').trim().split('\n')[0].slice(0, 80);
            return resolve({ found: true, path: list[i], version });
          }
          tryOne(i + 1);
        });
      })(0);
    });
  });
}

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
    // 优先取字符串型 id（id_str/rest_id）：数字型 id 会在 JSON.parse 阶段被双精度舍入，
    // 令相邻雪花 id 坍缩碰撞而漏推；对象型 id 无法得到稳定字符串键，直接跳过。
    const idRaw = it.id_str ?? it.rest_id ?? it.tweet_id ?? it.id ?? null;
    if (idRaw == null) continue;
    let id;
    if (typeof idRaw === 'string') id = idRaw;
    else if (typeof idRaw === 'number') id = String(idRaw);
    else continue;
    if (!id) continue;
    let name = it.author ?? (it.user && it.user.name) ?? it.name ?? account;
    if (name && typeof name === 'object') name = name.name || name.screen_name || name.username || account;
    out.push({
      id,
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
    execFile(birdPath, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return resolve({ ok: false, tweets: null, error: `bird 可执行文件不存在: ${birdPath}`, raw: '' });
        }
        // 非零退出 / 超时 / 缓冲溢出一律判失败——绝不因"碰巧能解析出 JSON（含空数组）"而误判成功，
        // 否则鉴权过期等错误会被伪装成"无新推文"造成静默失盲。
        const error = err.killed ? 'bird 执行超时' : `bird 执行失败（退出码 ${err.code ?? '非零'}）`;
        return resolve({ ok: false, tweets: null, error, raw: String(stderr || stdout || '').slice(0, 400) });
      }
      // 只解析 stdout；stderr 仅作诊断，避免其中的括号污染 JSON 抽取而把成功拉取误判为失败。
      const data = extractJSON(stdout);
      const tweets = normalizeTweets(data, username);
      if (tweets === null) {
        return resolve({ ok: false, tweets: null, error: 'bird 输出非 JSON', raw: String(stdout || '').slice(0, 400) });
      }
      resolve({ ok: true, tweets, error: null, raw: '' });
    });
  });
}

module.exports = { fetchTweets, extractJSON, normalizeTweets, detectBird };
