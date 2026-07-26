'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../lib/state');

test('logger bounds each line and installs an async stdout error handler', () => {
  assert.ok(process.stdout.listenerCount('error') > 0);
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = () => true;
    state.log('x'.repeat(10000));
  } finally {
    process.stdout.write = originalWrite;
  }
  const line = state.getLogs(1)[0];
  assert.match(line.msg, /日志已截断/);
  assert.ok(line.msg.length < 4200);

  try {
    process.stdout.write = () => true;
    state.log('x'.repeat(4095) + '😀tail');
  } finally {
    process.stdout.write = originalWrite;
  }
  const surrogateLine = state.getLogs(1)[0];
  assert.notEqual(surrogateLine.msg.charCodeAt(4095), 0xD83D);

  try {
    process.stdout.write = () => true;
    state.log('same');
    state.log('same');
  } finally {
    process.stdout.write = originalWrite;
  }
  const duplicateText = state.getLogs(2);
  assert.notEqual(duplicateText[0].id, duplicateText[1].id);
});
