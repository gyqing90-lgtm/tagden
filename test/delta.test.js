'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/delta');

function sample(size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + (i >> 8) * 17) & 0xff;
  return b;
}

test('补丁能还原插入、删除和改写的文件', () => {
  const old = sample(300 * 1024);
  const mid = Buffer.from('---- 插入的新内容 ----');
  const newBuf = Buffer.concat([old.subarray(0, 50 * 1024), mid, old.subarray(50 * 1024, 180 * 1024), Buffer.from('REPLACED'), old.subarray(190 * 1024)]);

  const patch = D.createPatch(old, newBuf);
  const out = D.applyPatch(old, patch);
  assert.deepEqual(out, newBuf);
  // 真实场景里补丁应远小于完整文件；这里只确认没有把整个旧文件塞进去
  assert.ok(patch.length < newBuf.length);
});

test('旧文件对不上时拒绝应用', () => {
  const old = sample(120 * 1024);
  const next = Buffer.concat([old, Buffer.from('tail')]);
  const patch = D.createPatch(old, next);
  const bad = Buffer.from(old);
  bad[0] ^= 0xff;
  assert.throws(() => D.applyPatch(bad, patch), /不匹配/);
});

test('补丁损坏时抛错，不会产出半截文件', () => {
  const old = sample(80 * 1024);
  const next = Buffer.concat([old.subarray(0, 40 * 1024), Buffer.from('x'), old.subarray(40 * 1024)]);
  const patch = D.createPatch(old, next);
  const bad = Buffer.from(patch);
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => D.applyPatch(old, bad));
});

test('切块边界只由内容决定', () => {
  const b = sample(200 * 1024);
  const a = D.chunkBounds(Buffer.concat([b]));
  const c = D.chunkBounds(Buffer.concat([b]));
  assert.deepEqual(a, c);
});
