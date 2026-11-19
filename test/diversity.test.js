'use strict';
/**
 * 区系分析指标：多样性指数、优势度分级、稀疏化与累积曲线。
 * 全部喂构造好的 record，答案用教科书公式手算，不碰磁盘。
 */

const test = require('node:test');
const assert = require('node:assert');
const DIV = require('../lib/diversity');

function rec(cn, latin, over) {
  return {
    labeled: true,
    taxon: { resolved: true, cn, latin, family: 'F', order: 'O' },
    taken: new Date(2026, 4, 3, 8, 0),
    stem: cn,
    ...over,
  };
}

/** n 张同种 */
function repeat(cn, latin, n, base) {
  return Array.from({ length: n }, (_, i) =>
    rec(cn, latin, { stem: `${cn}${i}`, taken: new Date(2026, 4, 3, 8, i % 60) }),
  ).concat(base || []);
}

test('四种各 25 张：H′/D/J/R/Berger-Parker 与手算一致', () => {
  const records = [
    ...repeat('甲', 'Alpha one', 25),
    ...repeat('乙', 'Beta two', 25),
    ...repeat('丙', 'Gamma three', 25),
    ...repeat('丁', 'Delta four', 25),
  ];
  const d = DIV.indices(records);
  assert.strictEqual(d.S, 4);
  assert.strictEqual(d.N, 100);
  assert.ok(Math.abs(d.shannon - Math.log(4)) < 1e-4, `H′ 应为 ln4，实际 ${d.shannon}`);
  assert.strictEqual(d.simpson, 0.75, '均匀四分：1 − 4×0.0625');
  assert.strictEqual(d.simpsonInv, 4);
  assert.strictEqual(d.pielou, 1, '完全均匀时均匀度为 1');
  assert.ok(Math.abs(d.margalef - 3 / Math.log(100)) < 1e-3);
  assert.strictEqual(d.bergerParker, 0.25);
  assert.strictEqual(d.chao1, 4, '没有单次种，Chao1 就等于实测种数');
  assert.strictEqual(d.completeness, 1);
});

test('单一物种：H′ 与均匀度为 0，不是 NaN', () => {
  const d = DIV.indices(repeat('甲', 'Alpha one', 10));
  assert.strictEqual(d.S, 1);
  assert.strictEqual(d.shannon, 0);
  assert.strictEqual(d.pielou, 0);
  assert.strictEqual(d.simpson, 0);
  assert.strictEqual(d.margalef, 0);
  assert.strictEqual(d.bergerParker, 1, '唯一的种占全部个体');
});

test('空输入全为 0，不产生 NaN', () => {
  const d = DIV.indices([]);
  assert.strictEqual(d.S, 0);
  assert.strictEqual(d.N, 0);
  for (const k of ['shannon', 'simpson', 'simpsonInv', 'pielou', 'margalef', 'bergerParker', 'chao1', 'completeness']) {
    assert.strictEqual(d[k], 0, `${k} 应为 0`);
    assert.ok(Number.isFinite(d[k]), `${k} 不能是 NaN`);
  }
});

test('Chao1 偏差校正式：f1=2、f2=3 时加 2/(2×4)', () => {
  const records = [
    ...repeat('单1', 'S one', 1),
    ...repeat('单2', 'S two', 1),
    ...repeat('双1', 'D one', 2),
    ...repeat('双2', 'D two', 2),
    ...repeat('双3', 'D three', 2),
    ...repeat('三1', 'T one', 3),
  ];
  const d = DIV.indices(records);
  assert.strictEqual(d.S, 6);
  assert.strictEqual(d.f1, 2);
  assert.strictEqual(d.f2, 3);
  assert.strictEqual(d.chao1, 6.25);
  assert.ok(d.completeness > 0.9 && d.completeness < 1, '完整度应略小于 1');
});

test('优势度分级按 5% / 1% 切三档', () => {
  // 212 张：47% / 18.9%（优势）· 3.8%×3 + 1.4%×4（常见）· 0.47%×36（稀有）
  const records = [
    ...repeat('优势1', 'Dom one', 100),
    ...repeat('优势2', 'Dom two', 40),
    ...repeat('常见1', 'C one', 8),
    ...repeat('常见2', 'C two', 8),
    ...repeat('常见3', 'C three', 8),
    ...repeat('次常1', 'M one', 3),
    ...repeat('次常2', 'M two', 3),
    ...repeat('次常3', 'M three', 3),
    ...repeat('次常4', 'M four', 3),
  ];
  for (let i = 0; i < 36; i += 1) records.push(...repeat(`稀${i}`, `R ${i}`, 1));
  const d = DIV.indices(records);
  assert.strictEqual(d.N, 212);
  assert.strictEqual(d.S, 2 + 3 + 4 + 36);
  assert.strictEqual(d.dominance.counts.dominant, 2, '≥5% 只有前两个');
  assert.strictEqual(d.dominance.counts.common, 7, '3 个 3.8% + 4 个 1.4%');
  assert.strictEqual(d.dominance.counts.rare, 36, '0.47% 全落稀有');
});

test('稀疏化：k=1 只有 1 种，k=N 等于总种数', () => {
  const counts = [5, 5];
  const out = DIV.rarefaction(counts, [1, 5, 10]);
  assert.deepStrictEqual(out.map((x) => x.n), [1, 5, 10]);
  assert.strictEqual(out[0].s, 1);
  assert.ok(Math.abs(out[1].s - 2 * (1 - 1 / 252)) < 1e-3, 'k=5 的期望物种数');
  assert.strictEqual(out[2].s, 2);
});

test('稀疏化：单种个体再多也恒为 1', () => {
  const out = DIV.rarefaction([10], [1, 3, 10]);
  assert.deepStrictEqual(out.map((x) => x.s), [1, 1, 1]);
});

test('累积曲线：按时间顺序首见累加，同日合并成一个采样单元', () => {
  const records = [
    rec('甲', 'Alpha one', { taken: new Date(2026, 4, 1, 9, 0) }),
    rec('甲', 'Alpha one', { taken: new Date(2026, 4, 1, 10, 0) }),
    rec('乙', 'Beta two', { taken: new Date(2026, 4, 2, 9, 0) }),
  ];
  const acc = DIV.accumulation(records);
  assert.strictEqual(acc.N, 3);
  assert.strictEqual(acc.S, 2);
  assert.deepStrictEqual(acc.observed.map((p) => p.s), [1, 1, 2]);
  assert.strictEqual(acc.byDay.length, 2);
  assert.strictEqual(acc.byDay[0].newSpecies, 1);
  assert.strictEqual(acc.byDay[0].photos, 2);
  assert.strictEqual(acc.byDay[1].cumSpecies, 2);
});

test('累积曲线：没有拍摄时间的记录不算进曲线，但指数仍按全部记录算', () => {
  const records = [
    rec('甲', 'Alpha one', { taken: null }),
    rec('乙', 'Beta two', { taken: new Date(2026, 4, 2, 9, 0) }),
  ];
  const acc = DIV.accumulation(records);
  assert.strictEqual(acc.observed.length, 1, '只有一张有时间，曲线只有一个点');
  assert.strictEqual(acc.N, 2, '稀疏化的个体数基数仍按全部已鉴定记录算');
  assert.strictEqual(DIV.indices(records).N, 2, '指数不受时间缺失影响');
});

test('降采样保留首尾，且不超过上限', () => {
  const pts = Array.from({ length: 500 }, (_, i) => ({ n: i + 1, s: i + 1 }));
  const out = DIV.decimate(pts, 50);
  assert.strictEqual(out.length, 50);
  assert.deepStrictEqual(out[0], pts[0]);
  assert.deepStrictEqual(out[out.length - 1], pts[pts.length - 1]);
});
