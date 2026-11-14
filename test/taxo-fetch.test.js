'use strict';
/**
 * 名录下载链路的回归测试：只测纯函数与本地文件判断，不联网、不真下载。
 * （真链路要在界面里点，见 lib/taxo-fetch.js 顶部的流程说明）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TXF = require('../lib/taxo-fetch');

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tagden-taxo-${tag}-`));
}

function rm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

test('looksLikeName：只认名字像名录的条目，下载中的临时文件不算', () => {
  const yes = [
    'Chinese-Latin.zip',
    'Chinese Latin',
    'Chinese_Latin.7z',
    'backbone_中文.sqlite',
    'backbone.zip',
    '物种名录.zip',
    'species_list.rar',
  ];
  const no = [
    'Chinese-Latin.zip.baiduyun.downloading',
    'backbone.zip.part',
    '我的照片.zip',
    'IMG_2031.jpg',
    '',
    '.DS_Store',
  ];
  for (const n of yes) assert.equal(TXF.looksLikeName(n), true, `应认作名录：${n}`);
  for (const n of no) assert.equal(TXF.looksLikeName(n), false, `不该认作名录：${n}`);
});

test('findDbDeep：文件夹里往下三层能挖到数据库', () => {
  const root = tmpDir('deep');
  try {
    const nested = path.join(root, 'Chinese-Latin', 'dump', 'x');
    fs.mkdirSync(nested, { recursive: true });
    const db = path.join(nested, 'backbone_中文.sqlite');
    fs.writeFileSync(db, 'x');
    assert.equal(TXF.findDbDeep(root, 4), db);
    // 层数不够时找不到，说明 depth 真的生效
    assert.equal(TXF.findDbDeep(root, 1), '');
  } finally {
    rm(root);
  }
});

test('findDbDeep：传进来的就是数据库文件时原样返回', () => {
  const root = tmpDir('file');
  try {
    const db = path.join(root, 'backbone.sqlite');
    fs.writeFileSync(db, 'x');
    assert.equal(TXF.findDbDeep(db), db);
  } finally {
    rm(root);
  }
});

test('scan：下载目录里的名录能列出来，无关文件不会混进来', () => {
  const root = tmpDir('scan');
  try {
    fs.writeFileSync(path.join(root, 'backbone_中文.sqlite'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(root, 'IMG_0001.jpg'), Buffer.alloc(4096));
    fs.mkdirSync(path.join(root, 'Chinese-Latin.zip.baiduyun.downloading'));
    fs.mkdirSync(path.join(root, '随便一个文件夹'));
    const list = TXF.scan([root]);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'db');
    assert.match(list[0].name, /backbone/);
  } finally {
    rm(root);
  }
});

test('install：指向文件夹就接入，找不到数据库时给人话错误', async () => {
  const root = tmpDir('install');
  try {
    const dir = path.join(root, 'Chinese-Latin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'backbone_中文.sqlite'), Buffer.alloc(2048));

    const r = await TXF.install(dir);
    assert.equal(r.ok, true);
    assert.equal(r.dir, dir);

    const empty = path.join(root, '空的');
    fs.mkdirSync(empty);
    const bad = await TXF.install(empty);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /没找到/);

    const missing = await TXF.install(path.join(root, '不存在的目录'));
    assert.equal(missing.ok, false);
    assert.match(missing.error, /找不到/);
  } finally {
    rm(root);
  }
});

test('install：下载目录里的名录文件夹会收进名录目录（免得清下载时被删）', async () => {
  const root = tmpDir('settle');
  try {
    const store = path.join(root, 'store');
    const dl = path.join(root, 'Downloads', 'Chinese-Latin');
    fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, 'backbone_中文.sqlite'), Buffer.alloc(2048));

    TXF.init({ dir: store }); // 指定落地目录 = 测试用的临时目录
    const r = await TXF.install(dl);
    assert.equal(r.ok, true);
    assert.equal(r.dir, store);
    assert.equal(fs.existsSync(path.join(store, 'backbone_中文.sqlite')), true);
    assert.equal(fs.existsSync(dl), false, '源文件夹应该已经搬走');
  } finally {
    rm(root);
  }
});

test('downloadDirs：返回的都是真实存在的目录', () => {
  for (const d of TXF.downloadDirs()) {
    assert.equal(fs.statSync(d).isDirectory(), true, d);
  }
});

test('分享链接带上了提取码，界面直接点就能进', () => {
  assert.match(TXF.BAIDU.href, /pan\.baidu\.com\/s\/[\w-]+/);
  assert.match(TXF.BAIDU.href, /pwd=591g/);
});
