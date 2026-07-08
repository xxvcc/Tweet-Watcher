'use strict';
// 运行时状态 + 日志环形缓冲 + 事件总线（供 SSE 实时推送给面板）。
const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

const MAX_LOGS = 500;
const logs = [];

let status = {
  running: false,      // worker 是否已启动
  paused: false,       // 是否被面板暂停监控
  startedAt: null,     // 服务启动时间
  accounts: {},        // username -> { lastCheck, ok, lastError, lastPushed, checking }
};

function nowISO() { return new Date().toISOString(); }

function log(msg) {
  const line = { t: nowISO(), msg: String(msg) };
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.shift();
  bus.emit('log', line);
  // 同时打到 stdout，交给 systemd/journald 留存与轮转
  process.stdout.write(`[${line.t}] ${line.msg}\n`);
}

function getLogs(limit = 200) {
  return logs.slice(-limit);
}

function getStatus() { return status; }

function setStatus(patch) {
  status = { ...status, ...patch };
  bus.emit('status', status);
}

function setAccount(user, patch) {
  status.accounts[user] = { ...(status.accounts[user] || {}), ...patch };
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

module.exports = { bus, log, getLogs, getStatus, setStatus, setAccount, pruneAccounts };
