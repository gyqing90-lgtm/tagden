'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const COLCN = require('../lib/colcn');

test('内置名录能查到常见种的规范中文名', () => {
  const r = COLCN.test('Papilio bianor');
  assert.equal(r.ready, true);
  assert.equal(r.cn, '碧翠凤蝶');
});

test('学名带亚属括号也能回落到种级', () => {
  assert.equal(COLCN.lookup('Papilio (Achillides) bianor'), '碧翠凤蝶');
});

test('查不到时保留原样，不抛错', () => {
  const r = COLCN.test('Thisgenus doesnotexist');
  assert.equal(r.ok, false);
  assert.equal(r.cn, '');
});
