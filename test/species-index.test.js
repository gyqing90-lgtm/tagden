'use strict';
/**
 * 跨目录物种索引：多根并存、合并去重、按 size+mtime 的扫描结果做缓存。
 * 用临时目录当 CACHE，不碰真实数据。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SPIDX = require('../lib/species-index');

function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spidx-'));
}

/** 造一条 library 风格的 item */
function item(root, rel, cn, latin, over) {
  const full = path.join(root, rel);
  return {
    path: full,
    name: path.basename(rel),
    cn,
    latin,
    size: 1000,
    mtime: new Date(2026, 4, 3).getTime(),
    date: new Date(2026, 4, 3).getTime(),
    gps: false,
    ...over,
  };
}

test('两个根目录的同一种要合并，张数相加、目录数记 2', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/photos/2025 秋季';
  const b = '/photos/2026 上半年';
  SPIDX.upsert(a, [item(a, '甲/1.jpg', '菜粉蝶', 'Pieris rapae'), item(a, '甲/2.jpg', '菜粉蝶', 'Pieris rapae')]);
  SPIDX.upsert(b, [item(b, '乙/1.jpg', '菜粉蝶', 'Pieris rapae'), item(b, '乙/2.jpg', '金凤蝶', 'Papilio machaon')]);

  const r = SPIDX.species();
  assert.strictEqual(r.total, 2, '两种');
  const pieris = r.list.find((s) => s.cn === '菜粉蝶');
  assert.strictEqual(pieris.n, 3, '跨根张数相加');
  assert.strictEqual(pieris.roots.length, 2);
  const papilio = r.list.find((s) => s.cn === '金凤蝶');
  assert.strictEqual(papilio.roots.length, 1);
});

test('大小写与空格不同的学名归并成一种', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/p/a';
  SPIDX.upsert(a, [item(a, '1.jpg', '菜粉蝶', 'Pieris rapae'), item(a, '2.jpg', '菜粉蝶', 'PIERIS RAPAE ')]);
  const r = SPIDX.species();
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.list[0].n, 2);
});

test('没有任何名字的图不进清单（省体积）', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/p/a';
  const res = SPIDX.upsert(a, [item(a, '1.jpg', '', ''), item(a, '2.jpg', '菜粉蝶', 'Pieris rapae')]);
  assert.strictEqual(res.count, 1, '只有一条有名字');
  assert.strictEqual(SPIDX.species().total, 1);
});

test('重复 upsert 同一个根是整根替换，不会累加', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/p/a';
  SPIDX.upsert(a, [item(a, '1.jpg', '菜粉蝶', 'Pieris rapae')]);
  SPIDX.upsert(a, [item(a, '1.jpg', '菜粉蝶', 'Pieris rapae')]);
  const r = SPIDX.species();
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.list[0].n, 1, '张数不能翻倍');
});

test('重新加载索引后数据还在，memo 失效后结果一致', () => {
  const cache = tmpCache();
  SPIDX.init({ cacheDir: cache });
  const a = '/p/a';
  SPIDX.upsert(a, [item(a, '1.jpg', '菜粉蝶', 'Pieris rapae'), item(a, '2.jpg', '金凤蝶', 'Papilio machaon')]);
  const before = SPIDX.species();

  SPIDX.init({ cacheDir: cache }); // 模拟重启
  const after = SPIDX.species();
  assert.strictEqual(after.total, before.total);
  assert.deepStrictEqual(after.list, before.list);
});

test('remove 掉一个根，清单随之缩小', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/p/a';
  const b = '/p/b';
  SPIDX.upsert(a, [item(a, '1.jpg', '菜粉蝶', 'Pieris rapae')]);
  SPIDX.upsert(b, [item(b, '1.jpg', '金凤蝶', 'Papilio machaon')]);
  assert.strictEqual(SPIDX.species().total, 2);
  SPIDX.remove(a);
  const r = SPIDX.species();
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.roots.length, 1);
});

test('搜索与排序：按张数默认降序，也能按学名', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/p/a';
  SPIDX.upsert(a, [
    item(a, '1.jpg', '菜粉蝶', 'Pieris rapae'),
    item(a, '2.jpg', '菜粉蝶', 'Pieris rapae'),
    item(a, '3.jpg', '金凤蝶', 'Papilio machaon'),
  ]);
  assert.deepStrictEqual(SPIDX.species().list.map((s) => s.cn), ['菜粉蝶', '金凤蝶']);
  assert.deepStrictEqual(SPIDX.species({ sort: 'latin' }).list.map((s) => s.latin), ['Papilio machaon', 'Pieris rapae']);
  assert.strictEqual(SPIDX.species({ q: '金凤' }).matched, 1);
});

test('首末日期来自拍摄时间，缺失时退回 mtime', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const a = '/p/a';
  SPIDX.upsert(a, [
    item(a, '1.jpg', '菜粉蝶', 'Pieris rapae', { date: new Date(2025, 2, 1).getTime() }),
    item(a, '2.jpg', '菜粉蝶', 'Pieris rapae', { date: 0, mtime: new Date(2026, 5, 18).getTime() }),
  ]);
  const s = SPIDX.species().list[0];
  assert.strictEqual(s.first, '2025-03-01');
  assert.strictEqual(s.last, '2026-06-18');
});

test('空索引不崩：没有根时清单为空', () => {
  SPIDX.init({ cacheDir: tmpCache() });
  const r = SPIDX.species();
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.list, []);
  assert.strictEqual(SPIDX.status().speciesCount, 0);
});
