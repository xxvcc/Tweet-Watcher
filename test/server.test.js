'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let server;
let base;
let listenUnavailable = false;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (e) {
    if (e && e.code === 'EPERM') { listenUnavailable = true; return; }
    throw e;
  }
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
});

test('panel entrypoint keeps assets relative for reverse-proxy subpaths', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /href="style\.css"/);
  assert.match(html, /src="app\.js"/);

  const script = await fetch(`${base}/app.js`);
  assert.match(script.headers.get('content-type') || '', /javascript/);
});

test('unknown frontend paths return 404 instead of an invalid asset-base fallback', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/nested/`);
  assert.equal(response.status, 404);
});

test('unknown API routes stay JSON 404 responses with security headers', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.deepEqual(await response.json(), { ok: false, error: '接口不存在' });
});

test('oversized JSON bodies retain the parser 413 status', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(300 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: '请求无效' });
});

test('malformed JSON remains a client-side 400 error', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: '请求无效' });
});
