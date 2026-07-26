'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');
const bird = require('../lib/bird');
const store = require('../lib/store');

test('account normalization ignores malformed username types instead of throwing', () => {
  const normalized = config.normalizeAccounts([
    { username: 123 },
    { username: {} },
    { username: false },
    { username: '@Valid_User', fetch_count: 999, check_interval: 1 },
  ]);
  assert.deepEqual(normalized, [{ username: 'Valid_User', fetch_count: 50, check_interval: 30 }]);
});

test('configuration string boundaries reject oversized paths and chat IDs', () => {
  assert.equal(config.validBirdPath('/tmp/' + 'a'.repeat(5000) + '/bird'), false);
  assert.equal(config.validChatId('1'.repeat(32)), true);
  assert.equal(config.validChatId('1'.repeat(33)), false);
  assert.equal(config.validChatId(Number.MAX_SAFE_INTEGER + 1), false);
});

test('malformed persisted secret types fail closed without degrading to empty values', () => {
  const original = store.readState;
  try {
    store.readState = () => ({ status: 'ok', value: { auth_token: { toString: null }, ct0: 123, tg_bot_token: false } });
    assert.throws(() => config.getSecrets(), (error) => error && error.code === 'DATA_CORRUPT');
  } finally {
    store.readState = original;
  }
});

test('persisted config keeps a durable revision and rejects truthy non-boolean pause values', () => {
  const original = store.readState;
  const originalWrite = store.writeJSON;
  let written = null;
  try {
    store.readState = () => ({ status: 'ok', value: { tg_chat_id: 0, paused: false, accounts: [], _revision: 7 } });
    store.writeJSON = (name, value) => { written = { name, value }; };
    const loaded = config.getConfig();
    assert.equal(loaded.tg_chat_id, '0');
    assert.equal(loaded.paused, false);
    assert.equal(loaded.revision, 7);
    assert.equal(loaded.persisted, true);
    assert.ok(config.nextRevision(loaded.revision) > loaded.revision);
    assert.throws(() => config.nextRevision(Number.MAX_SAFE_INTEGER), /\u7248\u672c/);
    config.saveConfig({ ...loaded, revision: 8 });
    assert.equal(written.name, 'config.json');
    assert.equal(written.value._revision, 8);
    assert.equal(Object.prototype.hasOwnProperty.call(written.value, 'revision'), false);
  } finally {
    store.readState = original;
    store.writeJSON = originalWrite;
  }
});

test('corrupt config and secrets files cannot be read as defaults or overwritten', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  let writes = 0;
  try {
    store.readState = () => ({ status: 'corrupt', value: undefined, error: new SyntaxError('injected') });
    store.writeJSON = () => { writes++; };
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.getSecrets(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveConfig({}), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveSecrets({}), (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(writes, 0);
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('a missing config rejects established secrets but permits a dedup-only migration', () => {
  const originalRead = store.readState;
  try {
    store.readState = (name) => name === 'config.json'
      ? { status: 'missing', value: undefined, error: null }
      : name === 'secrets.json'
        ? { status: 'ok', value: { auth_token: 'secret' }, error: null }
        : { status: 'missing', value: undefined, error: null };
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');

    store.readState = (name) => name === 'sent_ids.json'
      ? { status: 'ok', value: { alice: ['1'] }, error: null }
      : { status: 'missing', value: undefined, error: null };
    const migration = config.getConfig();
    assert.deepEqual(migration.accounts, []);
    assert.equal(migration.revision, 0);
    assert.equal(migration.persisted, false);
  } finally {
    store.readState = originalRead;
  }
});

test('structurally invalid persisted config also fails closed', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  let writes = 0;
  try {
    store.writeJSON = () => { writes++; };
    store.readState = () => ({ status: 'ok', value: { paused: 'false', accounts: [] }, error: null });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveConfig({
      bird_path: '/usr/bin/bird', tg_chat_id: '', paused: false, accounts: [], revision: 1,
    }), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = () => ({
      status: 'ok',
      value: { paused: false, accounts: [{ username: 123 }] },
      error: null,
    });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = () => ({
      status: 'ok',
      value: { paused: false, accounts: [{ username: 'alice', fetch_count: {} }] },
      error: null,
    });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = () => ({ status: 'ok', value: { auth_token: 123 }, error: null });
    assert.throws(() => config.saveSecrets({ auth_token: '', ct0: '', tg_bot_token: '' }),
      (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(writes, 0);
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('structurally invalid files cannot be overwritten through direct save calls', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  let writes = 0;
  try {
    store.writeJSON = () => { writes++; };
    store.readState = () => ({
      status: 'ok', value: { paused: false, accounts: [{ username: 123 }] }, error: null,
    });
    assert.throws(() => config.saveConfig({
      bird_path: '/usr/bin/bird', tg_chat_id: '', paused: false, accounts: [], revision: 1,
    }), (error) => error && error.code === 'DATA_CORRUPT');

    store.readState = () => ({ status: 'ok', value: [], error: null });
    assert.throws(() => config.saveSecrets({ auth_token: '', ct0: '', tg_bot_token: '' }),
      (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(writes, 0);
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('unsafe numeric tweet IDs are rejected before they can collide', () => {
  const parsed = JSON.parse('[{"id":9007199254740992},{"id":9007199254740993}]');
  assert.equal(parsed[0].id, parsed[1].id);
  assert.equal(bird.normalizeTweets(parsed, 'alice'), null);
});

test('one unsafe tweet ID fails a mixed batch instead of being silently dropped', () => {
  assert.equal(bird.normalizeTweets([
    { id_str: '123', text: 'valid' },
    { id: Number.MAX_SAFE_INTEGER + 1, text: 'precision lost' },
  ], 'alice'), null);
});

test('one malformed tweet entry fails a mixed batch instead of being silently dropped', () => {
  assert.equal(bird.normalizeTweets([
    { id_str: '123', text: 'valid' },
    { text: 'missing id' },
  ], 'alice'), null);
  assert.equal(bird.normalizeTweets([{ id_str: '123' }, null], 'alice'), null);
});

test('bird schema drift is distinct from an empty timeline', () => {
  assert.deepEqual(bird.normalizeTweets([], 'alice'), []);
  assert.equal(bird.normalizeTweets([{ unexpected: true }], 'alice'), null);
});

test('tweet fields are bounded at the ingestion boundary', () => {
  const tweets = bird.normalizeTweets([{
    id_str: '1'.repeat(32),
    text: 'x'.repeat(20000),
    created_at: 't'.repeat(1000),
    url: 'https://example.com/' + 'u'.repeat(4000),
  }], 'alice');
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].id.length, 32);
  assert.equal(tweets[0].text.length, 12000);
  assert.equal(tweets[0].time.length, 256);
  assert.equal(tweets[0].url.length, 2048);
  assert.equal(bird.normalizeTweets([{ id_str: '1'.repeat(33) }], 'alice'), null);
  assert.equal(bird.normalizeTweets(Array.from({ length: 101 }, (_, i) => ({ id_str: String(i + 1) })), 'alice'), null);
});

test('bird 0.8 compact output recognizes the standard retweet text prefix', () => {
  const [retweet, original] = bird.normalizeTweets([
    { id: '1', text: 'RT @source_user: shared text' },
    { id: '2', text: 'RT is only ordinary text here' },
  ], 'alice');
  assert.equal(retweet.is_rt, true);
  assert.equal(original.is_rt, false);
});

async function fetchFromFakeBird(stdout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-bird-'));
  const executable = path.join(dir, 'bird');
  try {
    // writeSync avoids a Node 24 child-process edge where a one-shot process.stdout.write can exit before flushing.
    fs.writeFileSync(executable, `#!/usr/bin/env node\nrequire('fs').writeSync(1, ${JSON.stringify(stdout)});\n`, { mode: 0o700 });
    return await bird.fetchTweets({
      birdPath: executable, username: 'alice', count: 1, authToken: 'auth', ct0: 'ct0',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fetch errors distinguish malformed JSON from an unsupported JSON schema', async () => {
  const malformed = await fetchFromFakeBird('not-json');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'bird 输出非 JSON');

  const unsupported = await fetchFromFakeBird('{"unexpected":true}');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, 'bird 输出结构不受支持', JSON.stringify(unsupported));

  const jsonNull = await fetchFromFakeBird('null');
  assert.equal(jsonNull.error, 'bird 输出结构不受支持');
});

test('bird fetch timeout uses an unignorable kill signal', { concurrency: false }, async () => {
  const childProcess = require('child_process');
  const modulePath = require.resolve('../lib/bird');
  const cached = require.cache[modulePath];
  const originalExecFile = childProcess.execFile;
  let options;
  try {
    childProcess.execFile = (file, args, opts, callback) => {
      options = opts;
      queueMicrotask(() => callback(Object.assign(new Error('timed out'), { killed: true }), '', ''));
      return {};
    };
    delete require.cache[modulePath];
    const isolatedBird = require('../lib/bird');
    const result = await isolatedBird.fetchTweets({
      birdPath: '/tmp/bird', username: 'alice', count: 1, authToken: 'auth', ct0: 'ct0',
    });
    assert.equal(result.ok, false);
    assert.equal(options.timeout, 30000);
    assert.equal(options.killSignal, 'SIGKILL');
  } finally {
    childProcess.execFile = originalExecFile;
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
  }
});

test('bird rejects invalid executable and argv values without spawning', async () => {
  const base = { username: 'alice', count: 1, authToken: 'auth', ct0: 'ct0' };
  const badPath = await bird.fetchTweets({ ...base, birdPath: '/bin/sh' });
  assert.equal(badPath.ok, false);
  assert.match(badPath.error, /路径非法/);

  const badCredential = await bird.fetchTweets({ ...base, birdPath: '/tmp/bird', authToken: 'bad\0token' });
  assert.equal(badCredential.ok, false);
  assert.match(badCredential.error, /格式非法/);

  const oversized = await bird.fetchTweets({ ...base, birdPath: '/tmp/bird', ct0: 'x'.repeat(4097) });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /格式非法/);
});
