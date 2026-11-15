'use strict';
/**
 * 统计仪表盘新增的几块统计：口径覆盖、时间线、趋势、热力图、器材、排行榜。
 * 这些是纯函数，直接用构造好的 records 验证，不碰磁盘。
 */

const test = require('node:test');
const assert = require('node:assert');
const STATS = require('../lib/stats');

function rec(over) {
  return {
    labeled: true,
    taxon: { resolved: true, cn: '菜粉蝶', latin: 'Pieris rapae' },
    gps: false,
    takenSrc: 'exif',
    body: '',
    taken: new Date(2026, 4, 3, 7, 30),
    regionLabel: '',
    project: '甲',
    folder: '甲/一',
    stem: 'a',
    path: '/tmp/a.jpg',
    ...over,
  };
}

test('coverage：没有 GPS 的图单独计数，时间来源分开算', () => {
  const records = [
    rec({ gps: true }),
    rec({ gps: true, takenSrc: 'file' }),
    rec({ gps: false }),
    rec({ gps: false, takenSrc: 'file' }),
  ];
  const c = STATS.coverage(records);
  assert.strictEqual(c.total, 4);
  assert.strictEqual(c.gps, 2);
  assert.strictEqual(c.noGps, 2);
  assert.strictEqual(c.timeExif, 2, 'exif 时间只有两张');
  assert.strictEqual(c.timeFile, 2, '文件时间两张');
});

test('coverage：taken 为空不计入任何一种时间来源', () => {
  const c = STATS.coverage([rec({ taken: null, takenSrc: '' })]);
  assert.strictEqual(c.timeExif, 0);
  assert.strictEqual(c.timeFile, 0);
});

test('byDimension：没有 GPS 的图不进地区统计，也不出现「未知地区」', () => {
  const rows = STATS.byDimension(
    [rec({ regionLabel: '福建省·三明市' }), rec({ regionLabel: '' }), rec({ regionLabel: '' })],
    'region'
  );
  assert.deepStrictEqual(rows, [{ name: '福建省·三明市', count: 1 }]);
  assert.ok(!rows.some((r) => r.name === '未知地区'), '空坐标不能落到「未知地区」里');
});

test('byDimension：整批都没有 GPS 时地区维度直接为空', () => {
  assert.deepStrictEqual(STATS.byDimension([rec({ regionLabel: '' })], 'region'), []);
});

test('timeline：年 / 月 / 时段分开统计，峰值时段取最大', () => {
  const records = [
    rec({ taken: new Date(2025, 0, 1, 13) }), // 中午
    rec({ taken: new Date(2026, 0, 2, 13) }), // 中午
    rec({ taken: new Date(2026, 2, 3, 7) }), // 清晨
    rec({ taken: new Date(2026, 2, 4, 23) }), // 夜间
  ];
  const t = STATS.timeline(records);
  assert.deepStrictEqual(t.years.map((y) => [y.key, y.count]), [['2026', 3], ['2025', 1]]);
  assert.deepStrictEqual(t.months.map((m) => m.month), [1, 3], '月份按自然顺序');
  assert.strictEqual(t.months[1].count, 2);
  assert.strictEqual(t.peak.name, '中午');
  assert.strictEqual(t.peak.count, 2);
});

test('timeline：时段顺序固定，缺失的时段直接不出现但顺序不乱', () => {
  const t = STATS.timeline([rec({ taken: new Date(2026, 4, 1, 20) }), rec({ taken: new Date(2026, 4, 2, 6) })]);
  assert.deepStrictEqual(t.hours.map((h) => h.name), ['清晨', '夜间']);
});

test('trendByMonth：物种按首见月计入「新增」，累计只增不减', () => {
  const A = { resolved: true, cn: '菜粉蝶', latin: 'Pieris rapae' };
  const B = { resolved: true, cn: '金凤蝶', latin: 'Papilio machaon' };
  const records = [
    rec({ taken: new Date(2026, 0, 5), taxon: A }),
    rec({ taken: new Date(2026, 0, 6), taxon: A }),
    rec({ taken: new Date(2026, 1, 7), taxon: B }),
    rec({ taken: new Date(2026, 1, 8), taxon: A }),
  ];
  const t = STATS.trendByMonth(records);
  assert.deepStrictEqual(t.map((m) => m.key), ['2026-01', '2026-02']);
  assert.strictEqual(t[0].photos, 2);
  assert.strictEqual(t[0].born, 1, '1 月新增 1 个物种');
  assert.strictEqual(t[0].cum, 1);
  assert.strictEqual(t[1].born, 1, '2 月又新增 1 个');
  assert.strictEqual(t[1].cum, 2, '累计递增');
  assert.strictEqual(t[1].photos, 2);
});

test('trendByMonth：没有拍摄时间的记录不参与', () => {
  assert.deepStrictEqual(STATS.trendByMonth([rec({ taken: null })]), []);
});

test('heatmap：只统计窗口内的日期，返回每日计数与最大值', () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10);
  const old = new Date(now.getTime() - 400 * 86400000);
  const h = STATS.heatmap([rec({ taken: today }), rec({ taken: today }), rec({ taken: old })], 365);
  assert.strictEqual(h.max, 2);
  assert.strictEqual(h.days.length, 1, '400 天前那张被窗口挡掉');
  assert.strictEqual(h.days[0].n, 2);
  assert.match(h.days[0].d, /^\d{4}-\d{2}-\d{2}$/);
});

test('recent：按时间倒序，只给前 N 张', () => {
  const records = [
    rec({ stem: 'old', taken: new Date(2026, 0, 1) }),
    rec({ stem: 'new', taken: new Date(2026, 5, 1) }),
    rec({ stem: 'mid', taken: new Date(2026, 2, 1) }),
  ];
  const r = STATS.recent(records, 2);
  assert.deepStrictEqual(r.map((x) => x.stem), ['new', 'mid']);
  // 必须是本地时间字符串，不能用 toISOString：东八区会显示成前一天
  assert.match(r[0].taken, /^2026-06-01 \d{2}:\d{2}:\d{2}$/);
});

test('gear：机身按出现次数排序，覆盖率按总张数算', () => {
  const records = [
    rec({ body: 'NIKON Z8' }),
    rec({ body: 'NIKON Z8' }),
    rec({ body: 'Apple iPhone 15' }),
    rec({ body: '' }),
  ];
  const g = STATS.gear(records);
  assert.deepStrictEqual(g.bodies.map((b) => [b.name, b.count]), [['NIKON Z8', 2], ['Apple iPhone 15', 1]]);
  assert.strictEqual(g.covered, 3);
  assert.strictEqual(g.rate, 0.75);
});

test('gear：一张都没有器材信息时覆盖率是 0 而不是 NaN', () => {
  const g = STATS.gear([rec({ body: '' })]);
  assert.strictEqual(g.rate, 0);
  assert.deepStrictEqual(g.bodies, []);
});

test('rankTable：带拉丁名归并，按数量降序', () => {
  const records = [
    rec({ taxon: { resolved: true, cn: '菜粉蝶', latin: 'Pieris rapae', family: 'Pieridae', familyCn: '粉蝶科' } }),
    rec({ taxon: { resolved: true, cn: '菜粉蝶', latin: 'Pieris rapae', family: 'Pieridae', familyCn: '粉蝶科' } }),
    rec({ taxon: { resolved: true, cn: '菜粉蝶', latin: 'Pieris rapae', family: 'Pieridae', familyCn: '粉蝶科' } }),
    rec({ taxon: { resolved: true, cn: '金凤蝶', latin: 'Papilio machaon', family: 'Papilionidae', familyCn: '凤蝶科' } }),
    rec({ taxon: { resolved: true, cn: '青凤蝶', latin: 'Graphium sarpedon', family: 'Papilionidae', familyCn: '凤蝶科' } }),
  ];
  const rows = STATS.rankTable(records, 'family');
  assert.strictEqual(rows[0].latin, 'Pieridae');
  assert.strictEqual(rows[0].count, 3);
  assert.strictEqual(rows[0].cn, '粉蝶科');
  assert.strictEqual(rows[1].latin, 'Papilionidae');
  assert.strictEqual(rows[1].count, 2);
});

test('rankTable：数量相同时按拉丁学名升序，结果稳定', () => {
  const records = [
    rec({ taxon: { resolved: true, latin: 'A b', family: 'Pieridae' } }),
    rec({ taxon: { resolved: true, latin: 'C d', family: 'Nymphalidae' } }),
    rec({ taxon: { resolved: true, latin: 'E f', family: 'Lycaenidae' } }),
  ];
  assert.deepStrictEqual(STATS.rankTable(records, 'family').map((r) => r.latin), ['Lycaenidae', 'Nymphalidae', 'Pieridae']);
});

test('rankTable：未解析分类的记录不进排行榜', () => {
  const rows = STATS.rankTable([rec({ taxon: { resolved: false, latin: 'X y', family: 'Z' } })], 'family');
  assert.deepStrictEqual(rows, []);
});
