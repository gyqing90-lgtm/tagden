'use strict';
/**
 * 统计快照缓存：图没动就不重读，动了（size/mtime 变）就必须重读。
 * 这些断言保护的是「统计数字不会因为缓存而变旧」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MOD = '../lib/stats-cache.js';
/** 模块是单例（内部缓存 db），换目录要重新 require */
function fresh() {
  delete require.cache[require.resolve(MOD)];
  return require(MOD);
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tagden-${prefix}-`));
}

const item = (cn, extra = {}) => ({
  cn,
  latin: 'Picus canus',
  ex: { dateTime: '2026:05:01 08:30:00', lat: 26.6, lon: 117.8, make: 'NIKON CORPORATION', model: 'NIKON Z8' },
  taken: new Date('2026-05-01T08:30:00'),
  takenSrc: 'exif',
  ...extra,
});

test('命中：size 与 mtime 一致时原样取回', () => {
  const dir = tmp('sc');
  const root = path.join(dir, 'photos');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'a.jpg');
  fs.writeFileSync(file, 'xxxx');
  const st = fs.statSync(file);

  const SC = fresh();
  const c = SC.open(path.join(dir, 'cache'), root);
  c.put('a.jpg', st, item('灰头绿啄木鸟'));
  const saved = c.save();
  assert.equal(saved.ok, true);
  assert.equal(saved.entries, 1);

  const c2 = SC.open(path.join(dir, 'cache'), root);
  const hit = c2.get('a.jpg', st);
  assert.ok(hit, '同样 size+mtime 应命中');
  assert.equal(hit.cn, '灰头绿啄木鸟');
  assert.equal(hit.latin, 'Picus canus');
  assert.equal(hit.ex.model, 'NIKON Z8');
  assert.equal(hit.ex.lat, 26.6);
  assert.equal(hit.takenSrc, 'exif');
  assert.equal(hit.taken.getTime(), new Date('2026-05-01T08:30:00').getTime());
  assert.equal(c2.status().hits, 1);
});

test('失效：文件变大 / mtime 变了都不能复用', () => {
  const dir = tmp('sc');
  const root = path.join(dir, 'photos');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'a.jpg');
  fs.writeFileSync(file, 'xxxx');
  const st = fs.statSync(file);

  const SC = fresh();
  const c = SC.open(path.join(dir, 'cache'), root);
  c.put('a.jpg', st, item('旧名字'));
  c.save();

  // 只改大小
  fs.writeFileSync(file, 'xxxxxxxx');
  const bigger = fs.statSync(file);
  const c2 = SC.open(path.join(dir, 'cache'), root);
  assert.equal(c2.get('a.jpg', bigger), null, 'size 变了必须失效');

  // 只改 mtime（同尺寸重存）
  const same = { size: bigger.size, mtimeMs: bigger.mtimeMs };
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const touched = fs.statSync(file);
  assert.equal(touched.size, same.size);
  const c3 = SC.open(path.join(dir, 'cache'), root);
  assert.equal(c3.get('a.jpg', touched), null, 'mtime 变了必须失效');
});

test('已删除的图会在下次落盘时被清掉', () => {
  const dir = tmp('sc');
  const root = path.join(dir, 'photos');
  fs.mkdirSync(root, { recursive: true });
  for (const n of ['a.jpg', 'b.jpg']) fs.writeFileSync(path.join(root, n), 'xx');
  const sa = fs.statSync(path.join(root, 'a.jpg'));
  const sb = fs.statSync(path.join(root, 'b.jpg'));

  const SC = fresh();
  const c = SC.open(path.join(dir, 'cache'), root);
  c.put('a.jpg', sa, item('A'));
  c.put('b.jpg', sb, item('B'));
  c.save();

  // 第二次进来 b.jpg 已经不在了（只看到 a.jpg）
  const c2 = SC.open(path.join(dir, 'cache'), root);
  c2.get('a.jpg', sa);
  c2.put('a.jpg', sa, item('A'));
  const r = c2.save();
  assert.equal(r.entries, 1);
  assert.equal(r.dropped, 1);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'stats-cache.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw.roots[root].files), ['a.jpg']);
});

test('不同文件夹的缓存互不串味', () => {
  const dir = tmp('sc');
  const r1 = path.join(dir, 'p1');
  const r2 = path.join(dir, 'p2');
  fs.mkdirSync(r1, { recursive: true });
  fs.mkdirSync(r2, { recursive: true });
  fs.writeFileSync(path.join(r1, 'a.jpg'), 'xxxx');
  fs.writeFileSync(path.join(r2, 'a.jpg'), 'xxxx');
  const st = fs.statSync(path.join(r1, 'a.jpg'));

  const SC = fresh();
  const c1 = SC.open(path.join(dir, 'cache'), r1);
  c1.put('a.jpg', st, item('一号文件夹'));
  c1.save();

  const c2 = SC.open(path.join(dir, 'cache'), r2);
  assert.equal(c2.get('a.jpg', st), null, '另一文件夹的同名文件不能复用');
});

test('缓存文件坏了只当没有，不抛错', () => {
  const dir = tmp('sc');
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'stats-cache.json'), '{ 这不是 JSON');

  const SC = fresh();
  const c = SC.open(cache, dir);
  assert.equal(c.get('a.jpg', { size: 1, mtimeMs: 1 }), null);
  c.put('a.jpg', { size: 1, mtimeMs: 1 }, item('X'));
  assert.equal(c.save().ok, true);
  const raw = JSON.parse(fs.readFileSync(path.join(cache, 'stats-cache.json'), 'utf8'));
  assert.equal(raw.version, 1);
});

test('文件夹换得多时只保留最近 6 个根', () => {
  const dir = tmp('sc');
  const cache = path.join(dir, 'cache');
  const SC = fresh();
  for (let i = 0; i < 8; i += 1) {
    const root = path.join(dir, `r${i}`);
    fs.mkdirSync(root, { recursive: true });
    const c = SC.open(cache, root);
    c.put('a.jpg', { size: 1, mtimeMs: 1 }, item(`第${i}个`));
    c.save();
  }
  const raw = JSON.parse(fs.readFileSync(path.join(cache, 'stats-cache.json'), 'utf8'));
  const roots = Object.keys(raw.roots);
  assert.equal(roots.length, 6, '最多留 6 个根');
  assert.ok(!roots.includes(path.join(dir, 'r0')), '最老的应先被淘汰');
  assert.ok(roots.includes(path.join(dir, 'r7')), '最新的必须在');
});

test('server 真正用上了快照（回归：别只在测试里存在）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/stats-cache'\)/);
  assert.match(src, /STATS_CACHE\.open\(CACHE, root\)/);
  assert.match(src, /sCache\.put\(f\.rel, st, item\)/);
  // 走快照时不能再读文件：命中分支必须落在 readLabelFastAsync 之前
  const start = src.indexOf('const hit = st ? sCache.get');
  const nextRead = src.indexOf('readLabelFastAsync', start);
  assert.ok(start > 0 && nextRead > start, '找不到快照命中分支');
  const seg = src.slice(start, nextRead);
  assert.match(seg, /return \{ f, cn: hit\.cn/, '命中就该直接返回，不往下走读文件');
  assert.ok(!/readLabelFastAsync/.test(seg), '命中分支里不该再读标签');
});

test('打包清单里有 stats-cache（漏了 exe 会报模块未打包）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'bundle.js'), 'utf8');
  assert.match(src, /'lib\/stats-cache\.js'/);
});
