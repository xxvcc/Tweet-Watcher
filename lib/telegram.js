'use strict';
// 通过 Telegram Bot API 发送消息（用 Node 内置 fetch）。

function formatTweet(t, account) {
  let timeStr = '';
  if (t.time) {
    const ts = Date.parse(t.time);
    if (!Number.isNaN(ts)) {
      timeStr = new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } else {
      timeStr = t.time;
    }
  }
  const label = t.is_rt ? '🔁 转推' : '🐦 新推文';
  let msg = `${label} @${account}\n\n发布时间：${timeStr}\nX链接：${t.url || ''}\n内容：\n${t.text || ''}`;
  if (msg.length > 4000) msg = msg.slice(0, 4000) + '\n\n…（内容已截断）';
  return msg;
}

// 返回 { ok, description }
async function sendMessage({ botToken, chatId, text }) {
  if (!botToken || !chatId || !/^-?\d+$/.test(String(chatId))) {
    return { ok: false, description: 'Telegram 配置无效（Bot Token / Chat ID）' };
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
    return { ok: false, description: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, description: e.name === 'TimeoutError' ? '请求超时' : e.message };
  }
}

module.exports = { sendMessage, formatTweet };
