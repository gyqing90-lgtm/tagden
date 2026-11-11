'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LIB = require('../lib/library');

test('图库索引：扫描、搜索、重复文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-library-'));
  const photos = path.join(root, 'photos');
  const sub = path.join(photos, 'sub');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'testpics', '蝴蝶_2.jpg'), path.join(photos, 'a.jpg'));
  fs.copyFileSync(path.join(__dirname, '..', 'testpics', '蝴蝶_2.jpg'), path.join(sub, 'b.jpg'));
  LIB.init({ cacheDir: cache });
  const st = await LIB.scan(photos);
  assert.equal(st.total, 2);
  const found = LIB.search({ q: '中华蝠蛾' });
  assert.equal(found.total, 2);
  assert.ok(found.items.every((x) => x.cn === '中华蝠蛾'));
  const dup = await LIB.duplicates();
  assert.equal(dup.groups.length, 1);
  assert.equal(dup.groups[0].items.length, 2);
  assert.equal(dup.groups[0].wasted > 0, true);
  fs.rmSync(root, { recursive: true, force: true });
});
