'use strict';
// 通过 Telegram Bot API 发送消息（用 Node 内置 fetch）。

// 解析推文时间：若原始串不含时区信息，Date.parse 会按【服务器本地时区】解释，
// 随后又渲染为 Asia/Shanghai，导致非 +08 服务器上"发布时间"系统性偏错。
// 因此对裸时间（无 Z / 无 ±hh:mm 偏移 / 无 GMT/UTC）显式按 UTC 解释。
function parseTweetTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return NaN;
  const hasTz = /(?:[zZ]$)|(?:[+-]\d{2}:?\d{2})|GMT|UTC/.test(s);
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(s);
  if (bare && !hasTz) return Date.parse(s.replace(' ', 'T') + 'Z');
  return Date.parse(s);
}

function formatTweet(t, account) {
  let timeStr = '';
  if (t.time) {
    const ts = parseTweetTime(t.time);
    timeStr = Number.isNaN(ts)
      ? String(t.time)
      : new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  const label = t.is_rt ? '🔁 转推' : '🐦 新推文';
  let msg = `${label} @${account}\n\n发布时间：${timeStr}\nX链接：${t.url || ''}\n内容：\n${t.text || ''}`;
  if (msg.length > 4000) msg = msg.slice(0, 4000) + '\n\n…（内容已截断）';
  return msg;
}

// 返回 { ok, description, retryAfter, permanent }
//   retryAfter: 429 时 Telegram 要求的等待秒数（供调用方退避）
//   permanent : 确定性失败（配置无效 / 4xx 参数错误），不值得重试
async function sendMessage({ botToken, chatId, text }) {
  if (!botToken || !chatId || !/^-?\d+$/.test(String(chatId))) {
    return { ok: false, description: 'Telegram 配置无效（Bot Token / Chat ID）', permanent: true };
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: String(chatId), text: String(text) }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok) return { ok: true };
    const retryAfter = (data && data.parameters && Number(data.parameters.retry_after)) || 0;
    // 4xx（非 429）为永久性参数错误；429/5xx/网络错误可重试
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    return { ok: false, description: (data && data.description) || `HTTP ${res.status}`, retryAfter, permanent };
  } catch (e) {
    // 超时/网络错误属瞬时，可重试
    return { ok: false, description: e.name === 'TimeoutError' ? '请求超时' : e.message };
  }
}

module.exports = { sendMessage, formatTweet };
