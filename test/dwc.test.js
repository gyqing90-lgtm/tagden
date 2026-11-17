'use strict';
/**
 * Darwin Core 导出：列名、行数、坐标口径、taxonID 对得上、meta.xml 索引不错位。
 * 这些错一个，导入 GBIF 就会整列错位，很难在界面上看出来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DWC = require('../lib/dwc.js');

const rows = [
  {
    file: 'a.jpg',
    rel: '2026春/a.jpg',
    cn: '灰头绿啄木鸟',
    latin: 'Picus canus',
    taken: '2026-05-01 08:30:00',
    lat: 26.6123,
    lon: 117.8456,
    alt: 820,
    source: '懂鸟',
    note: '鸣叫',
    folder: '2026春',
  },
  {
    file: 'b.jpg',
    rel: '2025秋/b.jpg',
    cn: '灰头绿啄木鸟',
    latin: 'Picus canus',
    taken: '2025-10-02 16:00:00',
    lat: null,
    lon: null,
    alt: null,
    source: '多识',
    note: '',
    folder: '2025秋',
  },
  {
    file: 'c.jpg',
    rel: '2025秋/c.jpg',
    cn: '白鹇',
    latin: 'Lophura nycthemera',
    taken: '',
    lat: 26.7,
    lon: 117.9,
    alt: null,
    source: '',
    note: '',
    folder: '2025秋',
  },
];

const species = [
  {
    cn: '灰头绿啄木鸟',
    latin: 'Picus canus',
    n: 2,
    kingdom: { latin: 'Animalia', cn: '动物界' },
    phylum: { latin: 'Chordata', cn: '脊索动物门' },
    class: { latin: 'Aves', cn: '鸟纲' },
    order: { latin: 'Piciformes', cn: '鴷形目' },
    family: { latin: 'Picidae', cn: '啄木鸟科' },
    genus: { latin: 'Picus', cn: '绿啄木鸟属' },
  },
  { cn: '白鹇', latin: 'Lophura nycthemera', n: 1, kingdom: {}, phylum: {}, class: {}, order: {}, family: {}, genus: {} },
];

const out = DWC.build(rows, species);
// 不能 trimEnd：最后一列常常是空的，trim 掉会把列数算少一个
const lines = (t) => t.replace(/\n$/, '').split('\n');

test('日期拆成 eventDate / year / month / day', () => {
  assert.deepEqual(DWC.splitDate('2026-05-01 08:30:00'), {
    eventDate: '2026-05-01',
    year: '2026',
    month: '05',
    day: '01',
  });
  assert.deepEqual(DWC.splitDate(''), { eventDate: '', year: '', month: '', day: '' });
  assert.deepEqual(DWC.splitDate('不知道'), { eventDate: '', year: '', month: '', day: '' });
});

test('每行列数一致，表头就是列名', () => {
  const ls = lines(out.occurrence);
  assert.equal(ls[0], DWC.OCC_COLUMNS.map((c) => c[0]).join('\t'));
  const n = ls[0].split('\t').length;
  for (const line of ls.slice(1)) assert.equal(line.split('\t').length, n, '列数必须一致');
  assert.equal(ls.length, 1 + rows.length);
});

test('坐标、基准面、国家按 DwC 口径填', () => {
  const ls = lines(out.occurrence).slice(1);
  const head = lines(out.occurrence)[0].split('\t');
  const at = (line, key) => line.split('\t')[head.indexOf(key)];

  assert.equal(at(ls[0], 'decimalLatitude'), '26.612300');
  assert.equal(at(ls[0], 'geodeticDatum'), 'WGS84');
  assert.equal(at(ls[0], 'countryCode'), 'CN');
  assert.equal(at(ls[0], 'basisOfRecord'), 'MachineObservation');

  // 没坐标的那行：经纬度与基准面都留空，不许写 0
  assert.equal(at(ls[1], 'decimalLatitude'), '');
  assert.equal(at(ls[1], 'geodeticDatum'), '');
});

test('学名优先，缺学名时退回中文名', () => {
  const ls = lines(out.occurrence).slice(1);
  const head = lines(out.occurrence)[0].split('\t');
  const at = (line, key) => line.split('\t')[head.indexOf(key)];
  assert.equal(at(ls[0], 'scientificName'), 'Picus canus');
  assert.equal(at(ls[0], 'vernacularName'), '灰头绿啄木鸟');
});

test('occurrenceID 稳定且不重复；taxonID 与物种表一致', () => {
  const ls = lines(out.occurrence).slice(1);
  const head = lines(out.occurrence)[0].split('\t');
  const ids = ls.map((l) => l.split('\t')[head.indexOf('occurrenceID')]);
  assert.equal(new Set(ids).size, ids.length, 'occurrenceID 不能撞');
  assert.equal(ids[0], DWC.occId('2026春/a.jpg'), '同一路径重导一次 ID 不变');

  const taxLines = lines(out.taxon).slice(1);
  const taxHead = lines(out.taxon)[0].split('\t');
  const taxIds = taxLines.map((l) => l.split('\t')[taxHead.indexOf('taxonID')]);
  assert.equal(taxIds.length, 2);
  for (const l of ls) assert.ok(taxIds.includes(l.split('\t')[head.indexOf('taxonID')]), '每行的 taxonID 都要在物种表里');
});

test('分类阶元带进核心表；查不到就留空而不是瞎填', () => {
  const ls = lines(out.occurrence).slice(1);
  const head = lines(out.occurrence)[0].split('\t');
  const at = (line, key) => line.split('\t')[head.indexOf(key)];
  assert.equal(at(ls[0], 'order'), 'Piciformes');
  assert.equal(at(ls[0], 'family'), 'Picidae');
  assert.equal(at(ls[0], 'phylum'), 'Chordata');
  // 白鹇那行分类没解析出来，界门也不能硬写成 Animalia
  const bai = ls.find((l) => l.includes('Lophura'));
  assert.equal(at(bai, 'order'), '');
  assert.equal(at(bai, 'kingdom'), '');
});

test('meta.xml 的 index 与列顺序一一对应', () => {
  const idx = [...out.meta.matchAll(/<field index="(\d+)" term="[^"]+\/(\w+)"\/>/g)].map((m) => [Number(m[1]), m[2]]);
  assert.equal(idx.length, DWC.OCC_COLUMNS.length);
  idx.forEach(([i, term], k) => {
    assert.equal(i, k, 'index 必须从 0 连续');
    assert.equal(term, DWC.OCC_COLUMNS[k][1], `第 ${k} 列术语不符`);
  });
  assert.match(out.meta, /rowType="http:\/\/rs\.tdwg\.org\/dwc\/terms\/Occurrence"/);
  assert.match(out.meta, /fieldsTerminatedBy="\\t"/);
  assert.ok(!out.meta.includes('metadata.xml'), '没有 metadata.xml 就不要指它');
});

test('统计口径：条数、物种数、带坐标数', () => {
  assert.deepEqual(out.counts, { occurrences: 3, taxa: 2, withCoord: 2 });
});

test('server 有导出路由，且与清单共用分类解析', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /'\/api\/export\/dwc'/);
  assert.match(src, /apiExportDwc/);
  assert.match(src, /await resolveSpeciesTaxo\(aggregateSpecies\(rows\)\)/);
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'build', 'bundle.js'), 'utf8');
  assert.match(bundle, /'lib\/dwc\.js'/);
});
