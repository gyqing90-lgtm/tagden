'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const secure = require('../lib/secure');

test('portable 密文可以原样解回对象', () => {
  const obj = { cn: '碧翠凤蝶', latin: 'Papilio bianor', nested: { list: [1, 2, 3] } };
  const sealed = secure.seal(obj, { portable: true });

  assert.match(sealed, /^BID1\.port\./);
  const opened = secure.open(sealed);
  assert.equal(opened.ok, true);
  assert.equal(opened.kdf, 'port');
  assert.deepEqual(opened.value, obj);
});

test('损坏的密文返回 ok:false，而不是抛异常', () => {
  const opened = secure.open('BID1.port.abc.def');
  assert.equal(opened.ok, false);
  assert.ok(opened.error);
});
