'use strict';
// 原子 JSON/文本读写。数据目录在网站根之外，只经本服务的路由暴露，永不被静态伺服。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
function dataPath(name) { return path.join(DATA_DIR, name); }

function readJSON(name, fallback) {
  try {
    const p = dataPath(name);
    if (!fs.existsSync(p)) return fallback;
    const txt = fs.readFileSync(p, 'utf8');
    if (!txt.trim()) return fallback;
    const v = JSON.parse(txt);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(name, data) {
  ensureDir();
  const p = dataPath(name);
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

module.exports = { DATA_DIR, ensureDir, dataPath, readJSON, writeJSON };
