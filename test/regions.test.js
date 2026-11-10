'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const REGIONS = require('../lib/regions');

test('离线行政区划能给出省·市', () => {
  assert.equal(REGIONS.labelFor(26.08, 119.30), '福建省·福州市');
  assert.equal(REGIONS.labelFor(24.48, 118.09), '福建省·厦门市');
  assert.equal(REGIONS.labelFor(27.75, 118.03), '福建省·武夷山市');
});

test('直辖市只显示市名', () => {
  assert.equal(REGIONS.labelFor(39.90, 116.40), '北京市');
  assert.equal(REGIONS.labelFor(31.23, 121.47), '上海市');
});

test('离最近城市太远时返回空，交给文件夹名', () => {
  assert.equal(REGIONS.labelFor(35.0, 90.0), '');
  assert.equal(REGIONS.labelFor(0, 0), '');
});

test('索引状态可读', () => {
  const s = REGIONS.stat();
  assert.equal(s.ready, true);
  assert.ok(s.count > 1000);
  assert.match(s.source, /GeoNames/);
});
