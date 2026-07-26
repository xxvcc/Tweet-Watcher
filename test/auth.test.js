'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const store = require('../lib/store');
const auth = require('../lib/auth');

test('password policy counts characters and enforces bcrypt 72-byte limit', () => {
  assert.ok(process.stderr.listenerCount('error') > 0);
  assert.equal(auth.passwordError('1234567'), '密码至少 8 位');
  assert.equal(auth.passwordError('😀😀😀😀'), '密码至少 8 位');
  assert.equal(auth.passwordError('😀😀😀😀😀😀😀😀'), '');
  assert.equal(auth.passwordError('a'.repeat(72)), '');
  assert.equal(auth.passwordError('a'.repeat(73)), '密码不能超过 72 个 UTF-8 字节');
  assert.equal(auth.passwordError({ toString: null }), '密码至少 8 位');
});

test('an existing structurally invalid password file fails closed', () => {
  const original = store.readState;
  try {
    store.readState = () => ({ status: 'ok', value: {}, error: null });
    assert.equal(auth.hasPassword(), true);
  } finally {
    store.readState = original;
  }
});

test('login rejects suffixes beyond bcrypt effective input boundary', async () => {
  const original = store.readJSON;
  try {
    const exact = 'a'.repeat(72);
    const hash = await bcrypt.hash(exact, 4);
    store.readJSON = () => ({ hash, input_policy: 'utf8-72-v1' });
    assert.equal(await auth.verifyPassword(exact), true);
    assert.equal(await auth.verifyPassword(exact + 'suffix'), false);
  } finally {
    store.readJSON = original;
  }
});

test('legacy unmarked hashes still accept historical passwords over 72 bytes', async () => {
  const originalRead = store.readJSON;
  const originalWrite = store.writeJSON;
  try {
    const legacy = 'a'.repeat(71) + 'é';
    const hash = await bcrypt.hash(legacy, 4);
    store.readJSON = () => ({ hash });
    store.writeJSON = () => { throw new Error('long legacy passwords must not be marked as migrated'); };
    assert.equal(Buffer.byteLength(legacy, 'utf8'), 73);
    assert.equal(await auth.verifyPassword(legacy), true);
  } finally {
    store.readJSON = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('unknown password input policies fail closed', async () => {
  const original = store.readJSON;
  try {
    const hash = await bcrypt.hash('correct-password', 4);
    store.readJSON = () => ({ hash, input_policy: 'unknown-future-policy' });
    assert.equal(await auth.verifyPassword('correct-password'), false);
  } finally {
    store.readJSON = original;
  }
});

test('epoch overflow rotates the signing key and resets the counter safely', () => {
  const originalReadState = store.readState;
  const originalWriteJSON = store.writeJSON;
  const oldKey = 'a'.repeat(64);
  let written = null;
  try {
    store.readState = () => ({ status: 'ok', value: { key: oldKey, epoch: Number.MAX_SAFE_INTEGER }, error: null });
    store.writeJSON = (name, value) => { if (name === 'session_secret.json') written = value; };
    auth.bumpEpoch();
    assert.equal(written.epoch, 1);
    assert.match(written.key, /^[0-9a-f]{64}$/);
    assert.notEqual(written.key, oldKey);
  } finally {
    store.readState = originalReadState;
    store.writeJSON = originalWriteJSON;
  }
});

test('sessions issued far in the future fail closed after a clock rollback', () => {
  const originalNow = Date.now;
  const base = originalNow();
  try {
    Date.now = () => base + 24 * 3600 * 1000;
    const futureSession = auth.makeSession();
    Date.now = () => base;
    assert.equal(auth.verifySession(futureSession), false);
  } finally {
    Date.now = originalNow;
  }
});
