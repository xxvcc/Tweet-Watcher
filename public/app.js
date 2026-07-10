'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const getCookie = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };

  // ---------- 主题：深色 / 浅色 / 跟随系统 ----------
  const THEME_KEY = 'tw_theme';
  const THEME_ORDER = ['system', 'light', 'dark'];
  const THEME_ICON = { system: '🌗', light: '☀️', dark: '🌙' };
  const THEME_NAME = { system: '跟随系统', light: '浅色', dark: '深色' };
  const curTheme = () => { const t = localStorage.getItem(THEME_KEY); return THEME_ORDER.indexOf(t) > -1 ? t : 'system'; };
  function applyTheme(t) {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const b = $('theme-toggle');
    if (b) { b.textContent = THEME_ICON[t]; b.title = '主题：' + THEME_NAME[t] + '（点击切换）'; }
  }
  applyTheme(curTheme());
  if ($('theme-toggle')) $('theme-toggle').onclick = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(curTheme()) + 1) % THEME_ORDER.length];
    localStorage.setItem(THEME_KEY, next); applyTheme(next);
  };

  // 这几个接口的 401 是业务语义（密码错误 / 未登录探测），不应触发跳转
  const KEEP_ON_401 = new Set(['api/session', 'api/login', 'api/setup']);

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (method !== 'GET') opts.headers['x-csrf'] = getCookie('tw_csrf');
    const res = await fetch(path, opts);
    let data = null; try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && !KEEP_ON_401.has(path)) {
      location.reload(); // 会话已失效：回登录页，而不是让面板停在过期数据上
      throw new Error('会话已失效，请重新登录');
    }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data || {};
  }

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg; t.className = 'msg ' + (kind || 'ok'); t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 6000);
  }

  function relTime(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function mmss(sec) {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtUptime(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 24) { const d = Math.floor(h / 24); return `${d}<small>天</small> ${h % 24}<small>h</small>`; }
    if (h > 0) return `${h}<small>h</small> ${m}<small>m</small>`;
    return `${m}<small>m</small>`;
  }

  // ---------- 认证 ----------
  let mode = 'login';
  function showAuth(needSetup) {
    mode = needSetup ? 'setup' : 'login';
    $('dash').classList.add('hidden'); $('settings').classList.add('hidden');
    $('auth').classList.remove('hidden');
    $('auth-title').textContent = needSetup ? '设置访问密码' : 'Tweet Watcher';
    $('auth-sub').textContent = needSetup ? '首次使用，请设置一个密码' : '请输入密码访问';
    $('auth-label').textContent = needSetup ? '设置密码' : '密码';
    $('auth-pw').placeholder = needSetup ? '至少 8 位' : '访问密码';
    $('auth-pw2-wrap').classList.toggle('hidden', !needSetup);
    $('auth-token-wrap').classList.toggle('hidden', !needSetup);
    $('auth-submit').textContent = needSetup ? '🔐 设置并进入' : '🔓 登录';
    $('auth-pw').value = ''; $('auth-pw2').value = ''; $('auth-setup-token').value = '';
  }
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('auth-pw').value, m = $('auth-msg');
    m.classList.add('hidden');
    try {
      if (mode === 'setup') {
        if (pw.length < 8) throw new Error('密码至少 8 位');
        if (pw !== $('auth-pw2').value) throw new Error('两次密码不一致');
        const token = $('auth-setup-token').value.trim();
        if (!token) throw new Error('请输入首次设置令牌（见服务端日志）');
        await api('POST', 'api/setup', { password: pw, setup_token: token });
      } else {
        await api('POST', 'api/login', { password: pw });
      }
      startPanel();
    } catch (err) { m.textContent = err.message; m.classList.remove('hidden'); }
  });

  // ---------- 数据 ----------
  let es = null;
  let statusData = { accounts: {}, running: false };
  let accountsCfg = [];
  const feedBuf = [];
  const feedSeen = new Set(); // 活动流去重键（防 SSE 重连回放重复）

  async function startPanel() {
    $('auth').classList.add('hidden');
    $('dash').classList.remove('hidden');
    await loadConfig();
    connectStream();
    renderAll();
  }

  // ---------- bird 路径提示 / 自动检测 ----------
  let birdOk = true;
  function birdHintColor(h, kind) { h.style.color = kind === 'warn' ? 'var(--bad)' : kind === 'ok' ? 'var(--good)' : ''; }
  function setBirdHint(kind, text) { const h = $('bird-hint'); if (!h) return; h.textContent = text; birdHintColor(h, kind); }     // 动态值走 textContent（防注入）
  function setBirdHintHTML(kind, html) { const h = $('bird-hint'); if (!h) return; h.innerHTML = html; birdHintColor(h, kind); }  // 仅用于固定文案（含 <code>）
  async function detectBird(auto) {
    const btn = $('btn-detect-bird');
    let old;
    if (btn && !auto) { btn.disabled = true; old = btn.textContent; btn.textContent = '检测中…'; }
    try {
      const r = await api('POST', 'api/detect-bird', {});
      if (r.found) {
        $('bird_path').value = r.path;
        setBirdHint('ok', '✅ 已检测到：' + r.path + (r.version ? '（' + r.version + '）' : '') + '，记得点保存。');
        if (!auto) toast('✅ 已检测到 bird：' + r.path, 'ok');
      } else {
        setBirdHintHTML('warn', '⚠ 未检测到 bird。请安装 <code>npm install -g @steipete/bird</code>，或手动填写路径。');
        if (!auto) toast('未检测到 bird，请先安装或手动填写路径', 'err');
      }
    } catch (e) { if (!auto) toast(e.message, 'err'); }
    finally { if (btn && !auto) { btn.disabled = false; btn.textContent = old; } }
  }

  async function loadConfig() {
    const c = await api('GET', 'api/config');
    accountsCfg = c.accounts || [];
    birdOk = c.birdOk !== false;
    $('bird_path').value = c.bird_path || '';
    $('tg_chat_id').value = c.tg_chat_id || '';
    const DOTS = '••••••••••••';
    $('auth_token').placeholder = c.secrets.hasAuthToken ? DOTS : '';
    $('ct0').placeholder = c.secrets.hasCt0 ? DOTS : '';
    $('tg_bot_token').placeholder = c.secrets.hasTgBotToken ? DOTS : '';
    renderAcctRows(accountsCfg);
    ['auth_token', 'ct0', 'tg_bot_token'].forEach(refreshReveal);
    if (!birdOk) setBirdHintHTML('warn', '⚠ 当前 bird 路径不存在。点「🔍 自动检测」或手动填写；未安装请 <code>npm install -g @steipete/bird</code>。');
    else setBirdHintHTML('', '当前路径可用。未安装可 <code>npm install -g @steipete/bird</code> 后点自动检测。');
  }

  // ---------- 顶栏 / 指标 ----------
  function renderTop() {
    const st = statusData || {};
    const pill = $('livepill'), txt = $('live-text');
    pill.className = 'livepill';
    if (!st.running) { pill.classList.add('off'); txt.textContent = '未运行'; }
    else if (st.paused) { pill.classList.add('paused'); txt.textContent = '已暂停'; }
    else { txt.textContent = '运行中'; }
    $('btn-pause').classList.toggle('hidden', !st.running || st.paused);
    $('btn-resume').classList.toggle('hidden', !st.running || !st.paused);
  }
  // 从未检查过的账号返回 null（区别于 rem=0，避免误显示"0:00 / 满格"）
  function nextCheckSec(cfgAcct) {
    const s = (statusData.accounts || {})[cfgAcct.username];
    if (!s || !s.lastCheck) return null;
    return (s.lastCheck + cfgAcct.check_interval * 1000 - Date.now()) / 1000;
  }
  function renderStats() {
    $('stat-accounts').textContent = accountsCfg.length;
    $('stat-pushes').textContent = statusData.pushesToday || 0;
    $('stat-uptime').innerHTML = statusData.startedAt ? fmtUptime(Date.now() - statusData.startedAt) : '—';
    let next = Infinity;
    if (!statusData.paused && statusData.running) {
      accountsCfg.forEach((a) => { const n = nextCheckSec(a); if (n != null && n < next) next = n; });
    }
    $('stat-next').textContent = (next !== Infinity) ? mmss(next) : '—';
  }

  // ---------- 账号卡片 ----------
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function statusOf(s) {
    if (s.checking) return { cls: 'wait', label: '检查中…' };
    if (s.ok === false) return { cls: 'err', label: '异常' };
    if (s.ok === true) return { cls: 'ok', label: '正常' };
    return { cls: 'idle', label: '等待' };
  }
  function buildBadge(cls, label) {
    const st = el('span', 'st ' + cls); st.appendChild(el('span', 'd')); st.appendChild(document.createTextNode(label));
    return st;
  }
  function buildBody(s) {
    if (s.ok === false && s.lastError) return el('div', 'errline', '⚠ ' + s.lastError);
    if (s.lastTweet && s.lastTweet.id) {
      const tw = el('div', 'tweet');
      const th = el('div', 'th'); th.appendChild(el('span', null, '最近推送')); th.appendChild(el('span', null, s.lastTweet.time || ''));
      tw.appendChild(th); tw.appendChild(document.createTextNode(s.lastTweet.text || ''));
      return tw;
    }
    return el('div', 'tweet empty', '暂无推送（自启动起无新推文）');
  }
  function buildSpark(s) {
    const spark = el('div', 'spark'); spark.title = '近期每次检查的推送量';
    const hist = Array.isArray(s.history) ? s.history.slice(-10) : [];
    const mx = Math.max(1, ...hist);
    for (let i = 0; i < 10; i++) {
      const v = hist[hist.length - 10 + i];
      const bar = el('i'); const h = (v == null) ? 0 : v;
      bar.style.height = (h > 0 ? Math.round(4 + (h / mx) * 18) : 4) + 'px';
      if (!h) bar.className = 'z';
      spark.appendChild(bar);
    }
    return spark;
  }

  function makeCard(cfgAcct) {
    const user = cfgAcct.username;
    const s = (statusData.accounts || {})[user] || {};
    const { cls, label } = statusOf(s);
    const card = el('div', 'card ' + cls); card.dataset.user = user;

    const top = el('div', 'card-top');
    const handle = el('span', 'handle'); handle.appendChild(el('span', 'at', '@')); handle.appendChild(document.createTextNode(user));
    top.appendChild(handle); top.appendChild(buildBadge(cls, label)); card.appendChild(top);

    const meta = el('div', 'meta');
    const m1 = el('span'); m1.appendChild(document.createTextNode('上次检查 ')); m1.appendChild(el('b', 'js-lastcheck', relTime(s.lastCheck)));
    const m2 = el('span'); m2.appendChild(document.createTextNode('上次推送 ')); m2.appendChild(el('b', 'js-lastpush', relTime(s.lastPushAt)));
    meta.appendChild(m1); meta.appendChild(m2); card.appendChild(meta);

    card.appendChild(buildBody(s));

    const foot = el('div', 'foot');
    foot.appendChild(buildSpark(s));
    const next = el('div', 'next');
    const lbl = el('div', 'lbl');
    lbl.appendChild(el('span', 'js-nextlbl', s.ok === false ? '下次重试' : '下次检查'));
    lbl.appendChild(el('span', 'tnum js-next', ''));
    const bar = el('div', 'bar'); const span = el('span', 'js-bar'); bar.appendChild(span);
    next.appendChild(lbl); next.appendChild(bar);
    foot.appendChild(next); card.appendChild(foot);

    updateCardTime(card, cfgAcct);
    return card;
  }

  // 原地更新已有卡片（避免每次 status 全量重建导致闪烁 / 进度条动画重置）
  function updateCard(card, cfgAcct) {
    const s = (statusData.accounts || {})[cfgAcct.username] || {};
    const { cls, label } = statusOf(s);
    card.className = 'card ' + cls;
    const oldBadge = card.querySelector('.st'); if (oldBadge) oldBadge.replaceWith(buildBadge(cls, label));
    const oldBody = card.querySelector('.tweet, .errline'); if (oldBody) oldBody.replaceWith(buildBody(s));
    const oldSpark = card.querySelector('.spark'); if (oldSpark) oldSpark.replaceWith(buildSpark(s));
    const lbl = card.querySelector('.js-nextlbl'); if (lbl) lbl.textContent = s.ok === false ? '下次重试' : '下次检查';
    updateCardTime(card, cfgAcct);
  }

  function updateCardTime(card, cfgAcct) {
    const s = (statusData.accounts || {})[cfgAcct.username] || {};
    const rem = nextCheckSec(cfgAcct);
    const nextEl = card.querySelector('.js-next'), barEl = card.querySelector('.js-bar');
    if (s.checking) { if (nextEl) nextEl.textContent = '进行中'; if (barEl) barEl.style.width = '100%'; }
    else if (!statusData.running || statusData.paused) { if (nextEl) nextEl.textContent = '—'; if (barEl) barEl.style.width = '0%'; }
    else if (rem == null) { if (nextEl) nextEl.textContent = '待检查'; if (barEl) barEl.style.width = '0%'; }
    else {
      if (nextEl) nextEl.textContent = mmss(rem);
      const prog = 1 - Math.max(0, rem) / cfgAcct.check_interval;
      if (barEl) { barEl.style.width = Math.min(100, Math.max(0, prog * 100)) + '%'; barEl.style.background = s.ok === false ? 'var(--bad)' : ''; }
    }
    const lc = card.querySelector('.js-lastcheck'); if (lc) lc.textContent = relTime(s.lastCheck);
    const lp = card.querySelector('.js-lastpush'); if (lp) lp.textContent = relTime(s.lastPushAt);
  }

  function sameUsers() {
    const cur = [].map.call($('cards').querySelectorAll('.card'), (c) => c.dataset.user);
    const want = accountsCfg.map((a) => a.username);
    return cur.length === want.length && cur.every((u, i) => u === want[i]);
  }
  function renderCards() {
    $('acct-count').textContent = accountsCfg.length;
    $('cards-empty').classList.toggle('hidden', accountsCfg.length > 0);
    const box = $('cards');
    if (sameUsers()) {
      accountsCfg.forEach((a) => { const card = box.querySelector('.card[data-user="' + (window.CSS && CSS.escape ? CSS.escape(a.username) : a.username) + '"]'); if (card) updateCard(card, a); });
    } else {
      box.textContent = '';
      accountsCfg.forEach((a) => box.appendChild(makeCard(a)));
    }
  }

  // 每秒只更新时间派生的文字/进度，不重建 DOM
  function tickTimes() {
    if ($('dash').classList.contains('hidden')) return;
    renderStats();
    [].forEach.call(document.querySelectorAll('#cards .card'), (card) => {
      const a = accountsCfg.find((x) => x.username === card.dataset.user);
      if (a) updateCardTime(card, a);
    });
  }

  // ---------- 活动流 ----------
  function classifyLog(msg) {
    if (msg.indexOf('✓') === 0 || msg.indexOf('✓ 推送') > -1) return { c: 'ok', i: '✓' };
    if (msg.indexOf('✗') === 0 || msg.indexOf('失败') > -1) return { c: 'err', i: '✗' };
    if (msg.indexOf('无新推文') > -1) return { c: 'mut', i: '○' };
    if (msg.indexOf('重试') > -1) return { c: 'mut', i: '↻' };
    return { c: 'mut', i: '◆' };
  }
  function feedLine(l) {
    const k = classifyLog(l.msg);
    const ev = el('div', 'ev ' + k.c);
    ev.appendChild(el('span', 'ico', k.i));
    const tx = el('div', 'tx');
    tx.appendChild(document.createTextNode(l.msg));
    let hhmmss = '';
    try { hhmmss = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false }); } catch (_) {}
    tx.appendChild(el('div', 't mono', hhmmss));
    ev.appendChild(tx);
    return ev;
  }
  function pushFeed(l) {
    const key = l.t + '|' + l.msg;
    if (feedSeen.has(key)) return; // 去重：SSE 重连回放的历史行不再重复插入
    feedSeen.add(key);
    feedBuf.push(l);
    while (feedBuf.length > 120) { const old = feedBuf.shift(); feedSeen.delete(old.t + '|' + old.msg); }
    const box = $('feed');
    box.insertBefore(feedLine(l), box.firstChild);
    while (box.children.length > 60) box.removeChild(box.lastChild);
  }

  function renderAll() { renderTop(); renderStats(); renderCards(); }

  // ---------- SSE ----------
  function connectStream() {
    if (es) es.close();
    es = new EventSource('api/stream');
    es.addEventListener('status', (e) => {
      try { statusData = JSON.parse(e.data); statusData.accounts = statusData.accounts || {}; renderAll(); } catch (_) {}
    });
    es.addEventListener('log', (e) => { try { pushFeed(JSON.parse(e.data)); } catch (_) {} });
    es.onerror = () => {
      // 只有网络层断开（readyState=CONNECTING）浏览器才会自动重连。
      // 响应非 200 或 Content-Type 不是 text/event-stream（如会话失效后的 401）会让
      // EventSource 永久关闭，此时必须刷新回登录页，否则面板静默冻结在旧数据上。
      if (es.readyState === EventSource.CLOSED) location.reload();
    };
  }

  // ---------- 设置抽屉 ----------
  let autoDetectTried = false;
  function openSettings() {
    $('settings').classList.remove('hidden');
    if (!birdOk && !autoDetectTried) { autoDetectTried = true; detectBird(true); }
  }
  function closeSettings() { $('settings').classList.add('hidden'); }
  $('btn-detect-bird').onclick = () => detectBird(false);
  $('btn-settings').onclick = openSettings;
  $('settings-close').onclick = closeSettings;
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });

  // 账号编辑行
  function makeAcctRow(a) {
    a = a || { username: '', fetch_count: 10, check_interval: 300 };
    const row = el('div', 'acct-row');
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'col-name'; name.placeholder = 'elonmusk'; name.value = a.username || ''; name.setAttribute('data-role', 'name');
    const fc = document.createElement('input');
    fc.type = 'number'; fc.className = 'col-num'; fc.min = 1; fc.max = 50; fc.value = a.fetch_count || 10; fc.setAttribute('data-role', 'fc');
    const iv = document.createElement('input');
    iv.type = 'number'; iv.className = 'col-num'; iv.min = 30; iv.max = 3600; iv.value = a.check_interval || 300; iv.setAttribute('data-role', 'iv');
    const del = document.createElement('button');
    del.className = 'btn-x col-x'; del.type = 'button'; del.textContent = '✕'; del.onclick = () => row.remove();
    row.append(name, fc, iv, del);
    return row;
  }
  function renderAcctRows(list) {
    const box = $('acct-list'); box.textContent = '';
    (list || []).forEach((a) => box.appendChild(makeAcctRow(a)));
  }
  function collectAccounts() {
    const out = [];
    $('acct-list').querySelectorAll('.acct-row').forEach((r) => {
      const u = r.querySelector('[data-role=name]').value.trim().replace(/^@/, '');
      if (!u) return;
      out.push({
        username: u,
        fetch_count: parseInt(r.querySelector('[data-role=fc]').value, 10) || 10,
        check_interval: parseInt(r.querySelector('[data-role=iv]').value, 10) || 300,
      });
    });
    return out;
  }
  $('btn-add-acct').onclick = () => { const r = makeAcctRow(); $('acct-list').appendChild(r); r.querySelector('input').focus(); };

  // 密钥字段显示切换（空字段隐藏眼睛；.secret 字段用 CSS 打码 + readonly 防自动填充）
  function addReveal(id) {
    const input = $(id);
    if (!input || (input.parentNode && input.parentNode.classList.contains('pw-wrap'))) return;
    const wrap = el('div', 'pw-wrap');
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pw-reveal'; btn.textContent = '👁'; btn.setAttribute('aria-label', '显示/隐藏');
    let isSecret = input.classList.contains('secret');
    if (isSecret) {
      input.setAttribute('readonly', '');
      const unlock = () => input.removeAttribute('readonly');
      input.addEventListener('focus', unlock); input.addEventListener('mousedown', unlock);
      // .secret 字段是 type=text + CSS 打码（避免密码管理器自动填充站点登录密码）。
      // 若 -webkit-text-security 不被支持、或样式表没加载成功，凭据就会明文显示；
      // 此时退回 type=password —— readonly-until-focus 仍在，自动填充风险远小于明文暴露。
      const cs = getComputedStyle(input);
      const masked = (cs.getPropertyValue('-webkit-text-security') || cs.webkitTextSecurity || '') === 'disc';
      if (!masked) { input.classList.remove('secret'); input.type = 'password'; isSecret = false; }
    }
    const showing = () => isSecret ? input.classList.contains('reveal') : input.type === 'text';
    const setShow = (on) => { if (isSecret) input.classList.toggle('reveal', on); else input.type = on ? 'text' : 'password'; btn.classList.toggle('on', on); };
    const sync = () => { const has = !!input.value; btn.style.display = has ? '' : 'none'; if (!has) setShow(false); };
    btn.onclick = () => setShow(!showing());
    input.addEventListener('input', sync);
    input._revealSync = sync; wrap.appendChild(btn); sync();
  }
  ['auth_token', 'ct0', 'tg_bot_token', 'old_pw', 'new_pw'].forEach(addReveal);
  function refreshReveal(id) { const e2 = $(id); if (e2 && e2._revealSync) e2._revealSync(); }

  function collectPayload() {
    const p = { bird_path: $('bird_path').value.trim(), tg_chat_id: $('tg_chat_id').value.trim(), accounts: collectAccounts() };
    const at = $('auth_token').value.trim(), ct = $('ct0').value.trim(), bt = $('tg_bot_token').value.trim();
    if (at) p.auth_token = at; if (ct) p.ct0 = ct; if (bt) p.tg_bot_token = bt;
    return p;
  }
  async function saveConfig() {
    const r = await api('POST', 'api/config', collectPayload());
    $('auth_token').value = ''; $('ct0').value = ''; $('tg_bot_token').value = '';
    ['auth_token', 'ct0', 'tg_bot_token'].forEach(refreshReveal);
    await loadConfig();
    renderAll();
    return r;
  }
  $('btn-save').onclick = async () => {
    try { const r = await saveConfig(); toast(r.warnings && r.warnings.length ? '⚠ ' + r.warnings.join('；') : '✅ 配置已保存', r.warnings && r.warnings.length ? 'err' : 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('btn-test-bird').onclick = async () => {
    const btn = $('btn-test-bird'); btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try { await saveConfig(); const r = await api('POST', 'api/test/bird', {}); toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; btn.textContent = old; }
  };
  $('btn-test-tg').onclick = async () => {
    const btn = $('btn-test-tg'); btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try { await saveConfig(); const r = await api('POST', 'api/test/telegram', {}); toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; btn.textContent = old; }
  };

  $('btn-pause').onclick = async () => { try { await api('POST', 'api/control', { action: 'pause' }); } catch (e) { toast(e.message, 'err'); } };
  $('btn-resume').onclick = async () => { try { await api('POST', 'api/control', { action: 'resume' }); } catch (e) { toast(e.message, 'err'); } };

  $('pw-toggle').onclick = () => $('pw-form').classList.toggle('hidden');
  $('btn-chpw').onclick = async () => {
    try {
      await api('POST', 'api/password', { old_password: $('old_pw').value, new_password: $('new_pw').value });
      $('old_pw').value = ''; $('new_pw').value = ''; ['old_pw', 'new_pw'].forEach(refreshReveal); $('pw-form').classList.add('hidden');
      toast('✅ 密码已修改');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('logout').onclick = async () => { try { await api('POST', 'api/logout'); } catch (_) {} location.reload(); };

  setInterval(tickTimes, 1000);

  // ---------- 启动 ----------
  (async function init() {
    try {
      const s = await api('GET', 'api/session');
      if (!s.hasPassword) showAuth(true);
      else if (!s.authed) showAuth(false);
      else startPanel();
    } catch (e) { showAuth(false); }
  })();
})();
