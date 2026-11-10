'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IDC = require('../lib/identify-cache');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-idc-'));
}

test('keyFor 对同图同站点稳定，换站点/换图/换名录版本会变', () => {
  IDC.init({ dir: tmpDir() });
  const img = { small: Buffer.from('pixels') };
  const base = IDC.keyFor(img, ['a', 'b'], 2026);

  assert.equal(IDC.keyFor(img, ['b', 'a'], 2026), base);
  assert.notEqual(IDC.keyFor(img, ['a'], 2026), base);
  assert.notEqual(IDC.keyFor({ small: Buffer.from('other') }, ['a', 'b'], 2026), base);
  assert.notEqual(IDC.keyFor(img, ['a', 'b'], 2027), base);
});

test('write/read 往返，过期后读不到', () => {
  const dir = tmpDir();
  IDC.init({ dir });
  const key = 'abc123';
  const result = { ok: true, siteCount: 1, rows: [] };

  assert.equal(IDC.write(key, result, 60 * 1000), true);
  assert.deepEqual(IDC.read(key), result);

  const file = path.join(dir, `${key}.json`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.at = Date.now() - 10 * 1000;
  j.ttl = 1000;
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal(IDC.read(key), null);
});

test('prune 删掉过期文件，保留过期时间内的', () => {
  const dir = tmpDir();
  IDC.init({ dir });
  const oldKey = 'old';
  const newKey = 'new';
  IDC.write(oldKey, { ok: true }, IDC.TTL);
  IDC.write(newKey, { ok: true }, IDC.TTL);

  const oldFile = path.join(dir, `${oldKey}.json`);
  const past = (Date.now() - IDC.TTL - 24 * 3600 * 1000) / 1000;
  fs.utimesSync(oldFile, past, past);

  assert.equal(IDC.prune(), 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(path.join(dir, `${newKey}.json`)), true);
});
