'use strict';
// 运行时状态 + 日志环形缓冲 + 事件总线（供 SSE 实时推送给面板）。
const EventEmitter = require('events');

const bus = new EventEmitter();
// 有界上限：足够容纳受控数量的 SSE 连接（每连接 2 个监听器）+ 余量。
// 不用 0(无限)，以便真出现监听器泄露时仍能被 Node 的告警暴露。
bus.setMaxListeners(64);

const MAX_LOGS = 500;
const logs = [];

let status = {
  running: false,      // worker 是否已启动
  paused: false,       // 是否被面板暂停监控
  startedAt: null,     // 服务启动时间
  lastTickAt: null,    // 最近一次 worker tick 完成时间（心跳，用于判活）
  accounts: Object.create(null), // username -> {...}；null 原型，避免 __proto__ 等保留字账号名污染
};

function nowISO() { return new Date().toISOString(); }

function log(msg) {
  const line = { t: nowISO(), msg: String(msg) };
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.shift();
  bus.emit('log', line);
  // 打到 stdout 交给 systemd/journald 留存；写失败(如 journald 重启导致 EPIPE)不得冒泡，
  // 否则会从调用方(worker loop 的 catch)抛出，令递归调度永久停摆。
  try { process.stdout.write(`[${line.t}] ${line.msg}\n`); } catch (_) {}
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
