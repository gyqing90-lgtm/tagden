'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions } = require('../lib/updater');

test('compareVersions 按数字比较，而不是按字符串', () => {
  assert.equal(compareVersions('0.6.23', '0.6.22'), 1);
  assert.equal(compareVersions('0.6.22', '0.6.23'), -1);
  assert.equal(compareVersions('0.6.22', '0.6.22'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0', '0.9.9'), 1);
});

test('compareVersions 容忍 v 前缀和预发布后缀', () => {
  assert.equal(compareVersions('v0.6.23', '0.6.22'), 1);
  assert.equal(compareVersions('0.6.23-beta.1', '0.6.23'), 0);
});
