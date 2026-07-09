'use strict';
// 原子 JSON/文本读写。数据目录在网站根之外，只经本服务的路由暴露，永不被静态伺服。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
function dataPath(name) { return path.join(DATA_DIR, name); }
function exists(name) { return fs.existsSync(dataPath(name)); }

// 读取并区分三态：missing(文件不存在，合法首启) / ok / corrupt(存在但为空/无法解析)。
// 关键：corrupt 绝不能被静默当成"未设置"——否则损坏的 password.json 会重开无认证 setup。
function readState(name) {
  const p = dataPath(name);
  if (!fs.existsSync(p)) return { status: 'missing', value: undefined, error: null };
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { status: 'corrupt', value: undefined, error: e }; }
  if (!txt.trim()) return { status: 'corrupt', value: undefined, error: new Error('空文件') };
  try {
    const v = JSON.parse(txt);
    if (v == null) return { status: 'corrupt', value: undefined, error: new Error('JSON 解析为 null') };
    return { status: 'ok', value: v, error: null };
  } catch (e) {
    return { status: 'corrupt', value: undefined, error: e };
  }
}

function readJSON(name, fallback) {
  const r = readState(name);
  if (r.status === 'corrupt') {
    // 不静默吞掉：存在但损坏的数据文件必须留痕（journald 可见），且保留原文件不覆盖
    try { process.stderr.write(`[store] ${name} 损坏，已回退默认值（原文件保留）：${r.error && r.error.message}\n`); } catch (_) {}
  }
  return r.status === 'ok' ? r.value : fallback;
}

function writeJSON(name, data) {
  ensureDir();
  const p = dataPath(name);
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const buf = Buffer.from(JSON.stringify(data, null, 2));
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);            // 数据块落盘，防断电/崩溃后留下 0 字节或半写文件
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    // 目录项 fsync，使 rename 本身持久化（否则崩溃后 rename 可能回退到旧文件）
    try { const dfd = fs.openSync(DATA_DIR, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (_) {}
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}  // 失败不遗留孤儿 .tmp
    throw e;
  }
}

// 启动时清理原子写残留的孤儿 .tmp（正常 rename 后不该存在，崩溃时可能残留）
function sweepTmp() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {} }
    }
  } catch (_) {}
}

module.exports = { DATA_DIR, ensureDir, dataPath, exists, readState, readJSON, writeJSON, sweepTmp };
