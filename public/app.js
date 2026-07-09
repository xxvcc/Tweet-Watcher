'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const getCookie = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (method !== 'GET') opts.headers['x-csrf'] = getCookie('tw_csrf');
    const res = await fetch(path, opts);
    let data = null; try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data || {};
  }

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'msg ' + (kind || 'ok');
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 6000);
  }

  function relTime(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    return Math.floor(s / 3600) + ' 小时前';
  }

  // ---------- 认证 ----------
  let mode = 'login'; // 'login' | 'setup'
  function showAuth(needSetup) {
    mode = needSetup ? 'setup' : 'login';
    $('panel').classList.add('hidden');
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
    const pw = $('auth-pw').value;
    const m = $('auth-msg');
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
    } catch (err) {
      m.textContent = err.message; m.classList.remove('hidden');
    }
  });

  // ---------- 面板 ----------
  let es = null;
  let lastStatus = { accounts: {} };

  async function startPanel() {
    $('auth').classList.add('hidden');
    $('panel').classList.remove('hidden');
    await loadConfig();
    connectStream();
  }

  async function loadConfig() {
    const c = await api('GET', 'api/config');
    $('bird_path').value = c.bird_path || '';
    $('tg_chat_id').value = c.tg_chat_id || '';
    $('auth_token').placeholder = c.secrets.hasAuthToken ? '已保存，留空保持不变' : '从浏览器 Cookie 获取';
    $('ct0').placeholder = c.secrets.hasCt0 ? '已保存，留空保持不变' : '从浏览器 Cookie 获取';
    $('tg_bot_token').placeholder = c.secrets.hasTgBotToken ? '已保存，留空保持不变' : '从 @BotFather 获取';
    renderAccounts(c.accounts || []);
  }

  function makeAcctRow(a) {
    a = a || { username: '', fetch_count: 10, check_interval: 300 };
    const row = document.createElement('div');
    row.className = 'acct-row';
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'col-name'; name.placeholder = 'elonmusk';
    name.value = a.username || ''; name.setAttribute('data-role', 'name');
    const fc = document.createElement('input');
    fc.type = 'number'; fc.className = 'col-num'; fc.min = 1; fc.max = 50; fc.value = a.fetch_count || 10; fc.setAttribute('data-role', 'fc');
    const iv = document.createElement('input');
    iv.type = 'number'; iv.className = 'col-num'; iv.min = 30; iv.max = 3600; iv.value = a.check_interval || 300; iv.setAttribute('data-role', 'iv');
    const badge = document.createElement('span');
    badge.className = 'col-badge'; badge.setAttribute('data-role', 'badge');
    const del = document.createElement('button');
    del.className = 'btn-x col-x'; del.type = 'button'; del.textContent = '✕';
    del.onclick = () => { row.remove(); };
    row.append(name, fc, iv, badge, del);
    return row;
  }

  function renderAccounts(list) {
    const box = $('acct-list');
    box.textContent = '';
    list.forEach((a) => box.appendChild(makeAcctRow(a)));
    paintBadges();
  }

  function collectAccounts() {
    const rows = $('acct-list').querySelectorAll('.acct-row');
    const out = [];
    rows.forEach((r) => {
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

  function paintBadges() {
    const acc = (lastStatus && lastStatus.accounts) || {};
    $('acct-list').querySelectorAll('.acct-row').forEach((r) => {
      const u = r.querySelector('[data-role=name]').value.trim().replace(/^@/, '');
      const b = r.querySelector('[data-role=badge]');
      const s = acc[u];
      if (!u) { b.className = 'col-badge'; b.innerHTML = ''; return; }
      let cls = 'idle', txt = '等待';
      if (s) {
        if (s.checking) { cls = 'run'; txt = '检查中…'; }
        else if (s.ok === false) { cls = 'err'; txt = '异常'; }
        else if (s.ok === true) { cls = 'ok'; txt = '正常 · ' + relTime(s.lastCheck); }
      }
      const span = document.createElement('span');
      span.className = 'badge ' + cls; span.textContent = txt;
      if (s && s.ok === false && s.lastError) span.title = s.lastError;
      b.className = 'col-badge'; b.textContent = ''; b.appendChild(span);
    });
  }

  function renderStatus(st) {
    lastStatus = st || { accounts: {} };
    const paused = !!st.paused;
    const running = !!st.running;
    const dot = $('run-dot'), txt = $('run-text');
    if (!running) { dot.className = 'dot off'; txt.textContent = '未运行'; }
    else if (paused) { dot.className = 'dot warn'; txt.textContent = '已暂停'; }
    else { dot.className = 'dot on'; txt.textContent = '运行中'; }
    $('btn-pause').classList.toggle('hidden', !running || paused);
    $('btn-resume').classList.toggle('hidden', !running || !paused);
    paintBadges();
  }

  function appendLog(l) {
    const box = $('logbox');
    const atBottom = box.scrollHeight - box.clientHeight <= box.scrollTop + 20;
    const div = document.createElement('div');
    div.className = 'line';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false }) + ' ';
    div.appendChild(ts);
    div.appendChild(document.createTextNode(l.msg));
    box.appendChild(div);
    while (box.children.length > 400) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function connectStream() {
    if (es) es.close();
    es = new EventSource('api/stream');
    es.addEventListener('status', (e) => { try { renderStatus(JSON.parse(e.data)); } catch (_) {} });
    es.addEventListener('log', (e) => { try { appendLog(JSON.parse(e.data)); } catch (_) {} });
    es.onerror = () => { /* EventSource 会自动重连 */ };
  }

  // ---------- 事件绑定 ----------
  $('logout').onclick = async () => { try { await api('POST', 'api/logout'); } catch (_) {} location.reload(); };
  $('log-toggle').onclick = () => $('log-wrap').classList.toggle('hidden');
  $('pw-toggle').onclick = () => $('pw-form').classList.toggle('hidden');
  $('btn-add-acct').onclick = () => { const r = makeAcctRow(); $('acct-list').appendChild(r); r.querySelector('input').focus(); };

  $('btn-pause').onclick = async () => { try { await api('POST', 'api/control', { action: 'pause' }); } catch (e) { toast(e.message, 'err'); } };
  $('btn-resume').onclick = async () => { try { await api('POST', 'api/control', { action: 'resume' }); } catch (e) { toast(e.message, 'err'); } };

  function collectPayload() {
    const p = { bird_path: $('bird_path').value.trim(), tg_chat_id: $('tg_chat_id').value.trim(), accounts: collectAccounts() };
    const at = $('auth_token').value.trim(), ct = $('ct0').value.trim(), bt = $('tg_bot_token').value.trim();
    if (at) p.auth_token = at; if (ct) p.ct0 = ct; if (bt) p.tg_bot_token = bt;
    return p;
  }

  async function saveConfig() {
    const r = await api('POST', 'api/config', collectPayload());
    // 清空密文输入框（已保存），并用返回的规范化账号重绘
    $('auth_token').value = ''; $('ct0').value = ''; $('tg_bot_token').value = '';
    if (r.accounts) renderAccounts(r.accounts);
    await loadConfig();
    return r;
  }

  $('btn-save').onclick = async () => {
    try {
      const r = await saveConfig();
      if (r.warnings && r.warnings.length) toast('⚠ ' + r.warnings.join('；'), 'err');
      else toast('✅ 配置已保存');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('btn-test-bird').onclick = async () => {
    const btn = $('btn-test-bird'); btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try { await saveConfig(); const r = await api('POST', 'api/test/bird', {}); toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = old; }
  };
  $('btn-test-tg').onclick = async () => {
    const btn = $('btn-test-tg'); btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try { await saveConfig(); const r = await api('POST', 'api/test/telegram', {}); toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = old; }
  };

  $('btn-chpw').onclick = async () => {
    try {
      await api('POST', 'api/password', { old_password: $('old_pw').value, new_password: $('new_pw').value });
      $('old_pw').value = ''; $('new_pw').value = ''; $('pw-form').classList.add('hidden');
      toast('✅ 密码已修改');
    } catch (e) { toast(e.message, 'err'); }
  };

  // ---------- 启动 ----------
  (async function init() {
    try {
      const s = await api('GET', 'api/session');
      if (!s.hasPassword) { showAuth(true); }
      else if (!s.authed) { showAuth(false); }
      else { startPanel(); }
    } catch (e) {
      showAuth(false);
    }
  })();
})();
