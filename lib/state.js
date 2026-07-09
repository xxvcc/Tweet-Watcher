'use strict';
// 运行时状态 + 日志环形缓冲 + 事件总线（供 SSE 实时推送给面板）。
const EventEmitter = require('events');

const bus = new EventEmitter();
// 有界上限：足够容纳受控数量的 SSE 连接（每连接 2 个监听器）+ 余量。
bus.setMaxListeners(64);

const MAX_LOGS = 500;
const HISTORY_LEN = 12; // 每账号保留最近多少次检查的推送量（供 sparkline）
const logs = [];

let status = {
  running: false,      // worker 是否已启动
  paused: false,       // 是否被面板暂停监控
  startedAt: null,     // 服务启动时间
  lastTickAt: null,    // 最近一次 worker tick 完成时间（心跳）
  pushesToday: 0,      // 今日已推送总数
  pushesTodayDate: null, // 今日日期（YYYY-MM-DD），跨天归零
  accounts: Object.create(null), // username -> 运行时状态
};

function nowISO() { return new Date().toISOString(); }
// 用展示时区（Asia/Shanghai）的日期作"今日"键，避免 UTC 日界与界面时间错位 8 小时
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }

function log(msg) {
  const line = { t: nowISO(), msg: String(msg) };
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.shift();
  bus.emit('log', line);
  // 打到 stdout 交给 journald；写失败(如 EPIPE)不得冒泡，否则会拖垮调用方(worker loop)。
  try { process.stdout.write(`[${line.t}] ${line.msg}\n`); } catch (_) {}
}

function getLogs(limit = 200) { return logs.slice(-limit); }
function getStatus() { return status; }

function setStatus(patch) {
  status = { ...status, ...patch };
  bus.emit('status', status);
}

function acct(user) {
  return status.accounts[user] || (status.accounts[user] = {});
}

function setAccount(user, patch) {
  status.accounts[user] = { ...acct(user), ...patch };
  bus.emit('status', status);
}

// 记录一次成功推送：全局今日计数（跨天归零）+ 该账号累计/最近推文
function addPush(user, tweet) {
  const d = today();
  if (status.pushesTodayDate !== d) { status.pushesToday = 0; status.pushesTodayDate = d; }
  status.pushesToday++;
  const a = acct(user);
  a.pushedTotal = (a.pushedTotal || 0) + 1;
  a.lastPushAt = Date.now();
  a.lastTweet = { text: String((tweet && tweet.text) || '').slice(0, 160), time: (tweet && tweet.time) || '', id: String((tweet && tweet.id) || '') };
  bus.emit('status', status);
}

// 记录一次检查的推送量（供 sparkline），保留最近 HISTORY_LEN 次
function pushHistory(user, n) {
  const a = acct(user);
  a.history = (a.history || []).concat(Number(n) || 0).slice(-HISTORY_LEN);
  bus.emit('status', status);
}

function pruneAccounts(activeUsers) {
  const set = new Set(activeUsers);
  let changed = false;
  for (const u of Object.keys(status.accounts)) {
    if (!set.has(u)) { delete status.accounts[u]; changed = true; }
  }
  if (changed) bus.emit('status', status);
}

module.exports = { bus, log, getLogs, getStatus, setStatus, setAccount, addPush, pushHistory, pruneAccounts };
