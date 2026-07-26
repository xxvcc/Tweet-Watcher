'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function makeState() {
  const status = { accounts: Object.create(null) };
  const logs = [];
  return {
    status,
    logs,
    setStatus(patch) { Object.assign(status, patch); },
    setAccount(user, patch) { status.accounts[user] = { ...(status.accounts[user] || {}), ...patch }; },
    getStatus() { return status; },
    pruneAccounts(users) {
      const active = new Set(users);
      for (const user of Object.keys(status.accounts)) if (!active.has(user)) delete status.accounts[user];
    },
    pushHistory() {},
    addPush() {},
    log(message) { logs.push(String(message)); },
  };
}

function loadWorker({ config, bird, telegram, state = makeState(), storedSent = {}, secrets }) {
  const paths = {
    worker: require.resolve('../lib/worker'),
    store: require.resolve('../lib/store'),
    config: require.resolve('../lib/config'),
    bird: require.resolve('../lib/bird'),
    telegram: require.resolve('../lib/telegram'),
    state: require.resolve('../lib/state'),
  };
  const saved = new Map(Object.values(paths).map((p) => [p, require.cache[p]]));
  const put = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  put(paths.store, { readJSON: (name) => name === 'sent_ids.json' ? storedSent : {}, writeJSON: () => {} });
  put(paths.config, {
    LIMITS: { MAX_SENT: 200 },
    validRevision: (value) => Number.isSafeInteger(value) && value >= 0,
    getConfig: () => {
      const value = typeof config === 'function' ? config() : config;
      return { ...value, revision: Number.isSafeInteger(value.revision) ? value.revision : 0 };
    },
    getSecrets: () => typeof secrets === 'function'
      ? secrets()
      : (secrets || { auth_token: 'auth', ct0: 'ct0x', tg_bot_token: 'bot' }),
  });
  put(paths.bird, bird);
  put(paths.telegram, telegram);
  put(paths.state, state);
  delete require.cache[paths.worker];
  const worker = require(paths.worker);
  return {
    worker,
    state,
    restore() {
      for (const [p, entry] of saved) {
        if (entry) require.cache[p] = entry;
        else delete require.cache[p];
      }
    },
  };
}

function account(username) {
  return { username, fetch_count: 10, check_interval: 30 };
}

const noSendTelegram = {
  formatTweet: (tweet) => tweet.id,
  sendMessage: async () => { throw new Error('sendMessage should not be called'); },
};

test('queued accounts skipped by pause remain immediately due after resume', { concurrency: false }, async () => {
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: ['a', 'b', 'c', 'd', 'e'].map(account),
  };
  const started = [];
  let release;
  let readyResolve;
  let released = false;
  const blocked = new Promise((resolve) => { release = () => { released = true; resolve(); }; });
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets({ username }) {
        started.push(username);
        if (started.length === 4) readyResolve();
        if (!released) await blocked;
        return { ok: true, tweets: [] };
      },
    },
    telegram: noSendTelegram,
  });
  try {
    const firstTick = harness.worker.tick();
    await ready;
    harness.worker.setPaused(true);
    release();
    await firstTick;
    assert.deepEqual(started.sort(), ['a', 'b', 'c', 'd']);

    harness.worker.setPaused(false);
    await harness.worker.tick();
    assert.equal(started.filter((user) => user === 'e').length, 1);
  } finally { harness.restore(); }
});

test('worker status uses the persistent config revision across start and changes', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [], revision: 42 };
  const harness = loadWorker({
    config,
    bird: { async fetchTweets() { return { ok: true, tweets: [] }; } },
    telegram: noSendTelegram,
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = () => 0;
    harness.worker.start();
    assert.equal(harness.state.status.configRevision, 42);
    config.revision = 43;
    harness.worker.configChanged();
    assert.equal(harness.state.status.configRevision, 43);
    // 让 loop() 的 finally 在恢复真实定时器前运行，避免测试遗留一个常驻 5 秒调度。
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a corrupt config blocks checks without crashing the web service startup', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: () => { throw Object.assign(new Error('config.json 损坏'), { code: 'DATA_CORRUPT' }); },
    bird: { async fetchTweets() { throw new Error('must not fetch with corrupt config'); } },
    telegram: noSendTelegram,
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = () => 0;
    assert.doesNotThrow(() => harness.worker.start());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
    assert.match(harness.state.logs.join('\n'), /配置读取失败/);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('corrupt secrets stop the worker and cannot leave a healthy heartbeat', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [], revision: 2 };
  const harness = loadWorker({
    config,
    secrets: () => { throw Object.assign(new Error('secrets.json 损坏'), { code: 'DATA_CORRUPT' }); },
    bird: { async fetchTweets() { throw new Error('must not fetch with corrupt secrets'); } },
    telegram: noSendTelegram,
  });
  try {
    await assert.rejects(harness.worker.tick(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
  } finally { harness.restore(); }
});

test('a runtime data-directory disappearance cannot clear an established dedup snapshot', { concurrency: false }, async () => {
  let present = true;
  let fetches = 0;
  const harness = loadWorker({
    config: () => ({
      bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
      accounts: present ? [account('alice')] : [], persisted: present,
    }),
    storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { fetches++; return { ok: true, tweets: [{ id: '1' }] }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(fetches, 1);
    present = false;
    await assert.rejects(harness.worker.tick(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(fetches, 1);
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
  } finally { harness.restore(); }
});

test('a dedup-only migration is retained until the first config is persisted', { concurrency: false }, async () => {
  let configured = false;
  const harness = loadWorker({
    config: () => ({
      bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
      accounts: configured ? [account('alice')] : [], persisted: configured,
    }),
    storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '1' }] }; } },
    telegram: noSendTelegram,
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = () => 0;
    harness.worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    configured = true;
    await harness.worker.tick();
    assert.match(harness.state.logs.join('\n'), /无新推文/);
    assert.doesNotMatch(harness.state.logs.join('\n'), /首次运行/);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a config change cancels the whole queued snapshot and does not consume its interval', { concurrency: false }, async () => {
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: ['a', 'b', 'c', 'd', 'e'].map(account),
  };
  const started = [];
  let release;
  let readyResolve;
  let released = false;
  const blocked = new Promise((resolve) => { release = () => { released = true; resolve(); }; });
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets({ username }) {
        started.push(username);
        if (started.length === 4) readyResolve();
        if (!released) await blocked;
        return { ok: true, tweets: [] };
      },
    },
    telegram: noSendTelegram,
  });
  try {
    const staleTick = harness.worker.tick();
    await ready;
    harness.worker.configChanged();
    release();
    await staleTick;
    assert.deepEqual(started.slice().sort(), ['a', 'b', 'c', 'd']);

    await harness.worker.tick();
    assert.equal(started.length, 9);
    for (const user of ['a', 'b', 'c', 'd']) {
      assert.equal(started.filter((item) => item === user).length, 2);
    }
    assert.equal(started.filter((item) => item === 'e').length, 1);
  } finally { harness.restore(); }
});

test('a restored empty dedup list rebuilds a baseline instead of mass-pushing', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let sends = 0;
  const harness = loadWorker({
    config,
    storedSent: { alice: [] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() { sends++; return { ok: true }; },
    },
  });
  const originalSetTimeout = global.setTimeout;
  try {
    // start() is the production path that restores sent_ids. Suppress only the recurring 5s loop;
    // short worker sleeps still resolve through microtasks so the test also fails cleanly on a regression.
    global.setTimeout = (fn, ms) => {
      if (ms !== 5000) queueMicrotask(fn);
      return 0;
    };
    harness.worker.start();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const accountState = harness.state.status.accounts.alice;
      if (accountState && accountState.checking === false) break;
    }
    assert.equal(sends, 0);
    assert.match(harness.state.logs.join('\n'), /首次运行，记录 2 条推文 ID，不推送/);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a failed older tweet blocks newer delivery and marks the account unhealthy', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  const sent = [];
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '3' }, { id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage({ text }) { sent.push(text); return { ok: false, permanent: true, description: 'bad chat' }; },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    await harness.worker.tick();
    assert.deepEqual(sent, ['2']);
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.match(harness.state.status.accounts.alice.lastError, /Telegram 推送失败/);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('pause during a failed send prevents every retry', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let resolveSend;
  let sendStartedResolve;
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      sendMessage() {
        sendCalls++;
        sendStartedResolve();
        return new Promise((resolve) => { resolveSend = resolve; });
      },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    const activeTick = harness.worker.tick();
    await sendStarted;
    harness.worker.setPaused(true);
    resolveSend({ ok: false, description: 'network down' });
    await activeTick;
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('a 429 received during pause is still honored after resume', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let resolveSend;
  let sendStartedResolve;
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      sendMessage() {
        sendCalls++;
        sendStartedResolve();
        return new Promise((resolve) => { resolveSend = resolve; });
      },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    const activeTick = harness.worker.tick();
    await sendStarted;
    harness.worker.setPaused(true);
    resolveSend({ ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' });
    await activeTick;

    harness.worker.setPaused(false);
    await harness.worker.tick();
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('a Telegram 429 creates global deferral without sleeping or retrying', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() {
        sendCalls++;
        return { ok: false, rateLimited: true, retryAfter: 30, description: 'too many requests' };
      },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    await harness.worker.tick();
    assert.equal(sendCalls, 1);
    assert.match(harness.state.status.accounts.alice.lastError, /限流/);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('the Telegram test endpoint shares the worker bot backoff', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() {
        sendCalls++;
        return { ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' };
      },
    },
  });
  try {
    const result = await harness.worker.testTelegram();
    assert.equal(result.ok, false);
    const repeated = await harness.worker.testTelegram();
    assert.match(repeated.message, /退避中/);
    await harness.worker.tick();
    now += 30001;
    await harness.worker.tick();
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('Telegram backoff is isolated between bot tokens', { concurrency: false }, async () => {
  const originalNow = Date.now;
  Date.now = () => 100000;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [] };
  let token = 'bot-a';
  const calls = [];
  const harness = loadWorker({
    config,
    secrets: () => ({ auth_token: 'auth', ct0: 'ct0x', tg_bot_token: token }),
    bird: { async fetchTweets() { return { ok: true, tweets: [] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage({ botToken }) {
        calls.push(botToken);
        return botToken === 'bot-a'
          ? { ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' }
          : { ok: true };
      },
    },
  });
  try {
    assert.equal((await harness.worker.testTelegram()).ok, false);
    token = 'bot-b';
    assert.equal((await harness.worker.testTelegram()).ok, true);
    assert.deepEqual(calls, ['bot-a', 'bot-b']);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('newly pinned old tweets are not backfilled and new tweets keep delivery order', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  const sent = [];
  const harness = loadWorker({
    config,
    storedSent: { alice: ['100'] },
    // A newly pinned old tweet can precede the newest tweet in bird's output.
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '50' }, { id: '110' }, { id: '100' }] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage({ text }) { sent.push(text); return { ok: true }; },
    },
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = (fn, ms) => {
      if (ms !== 5000) queueMicrotask(fn);
      return 0;
    };
    harness.worker.start();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const accountState = harness.state.status.accounts.alice;
      if (accountState && accountState.checking === false) break;
    }
    assert.deepEqual(sent, ['110']);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a config change during final delivery throttling cannot recreate a deleted account', { concurrency: false }, async () => {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')], revision: 1 };
  let round = 0;
  let releaseThrottle;
  let throttleStartedResolve;
  const throttleStarted = new Promise((resolve) => { throttleStartedResolve = resolve; });
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        round++;
        return round === 1
          ? { ok: true, tweets: [{ id: '100' }] }
          : { ok: true, tweets: [{ id: '101' }, { id: '100' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() { return { ok: true }; },
    },
  });
  try {
    global.setTimeout = (fn, ms) => {
      if (ms === 500) {
        releaseThrottle = fn;
        throttleStartedResolve();
      } else queueMicrotask(fn);
      return 0;
    };
    await harness.worker.tick();
    now += 30001;
    const secondTick = harness.worker.tick();
    await throttleStarted;
    config.accounts = [];
    config.revision = 2;
    harness.worker.configChanged(2);
    harness.state.pruneAccounts([]);
    releaseThrottle();
    await secondTick;
    assert.equal(Object.prototype.hasOwnProperty.call(harness.state.status.accounts, 'alice'), false);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('concurrent 429 responses report the longest active bot backoff', { concurrency: false }, async () => {
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: [account('alice'), account('bob')],
  };
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  let calls = 0;
  const harness = loadWorker({
    config,
    storedSent: { alice: ['1'], bob: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
    telegram: {
      formatTweet: (tweet, user) => user,
      async sendMessage({ text }) {
        calls++;
        if (calls === 2) releaseBoth();
        await bothStarted;
        return {
          ok: false,
          rateLimited: true,
          retryAfter: text === 'alice' ? 60 : 2,
          description: 'too many requests',
        };
      },
    },
  });
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  Date.now = () => 100000;
  try {
    global.setTimeout = () => 0; // suppress only the recurring loop; the 429 path does not sleep
    harness.worker.start();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const states = harness.state.status.accounts;
      if (states.alice && states.bob && !states.alice.checking && !states.bob.checking) break;
    }
    assert.equal(calls, 2);
    assert.match(harness.state.status.accounts.alice.lastError, /60s/);
    assert.match(harness.state.status.accounts.bob.lastError, /60s/);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});
