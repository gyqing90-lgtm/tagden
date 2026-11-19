'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildRtf, groupSpecies, rtfEscape } = require('../lib/species-rtf');

const S = (cn, latin, order, orderCn, family, familyCn) => ({ cn, latin, order, orderCn, family, familyCn });

const SAMPLE = [
  S('菜粉蝶', 'Pieris rapae', 'Lepidoptera', '鳞翅目', 'Pieridae', '粉蝶科'),
  S('金凤蝶', 'Papilio machaon', 'Lepidoptera', '鳞翅目', 'Papilionidae', '凤蝶科'),
  S('青凤蝶', 'Graphium sarpedon', 'Lepidoptera', '鳞翅目', 'Papilionidae', '凤蝶科'),
  S('东方蝼蛄', 'Gryllotalpa orientalis', 'Orthoptera', '直翅目', 'Gryllotalpidae', '蝼蛄科'),
  S('未知种', 'Unknownia sp.', '', '', '', ''),
];

test('rtfEscape：ASCII 原样，中文转 \\u，括号反斜杠转义', () => {
  assert.strictEqual(rtfEscape('abc 123'), 'abc 123');
  // RTF 的 \uN 是有符号 16 位：'金' = 37329 > 32767，要写成 -28207
  assert.strictEqual(rtfEscape('金'), '\\u-28207?');
  assert.strictEqual(rtfEscape('a{b}c\\d'), 'a\\{b\\}c\\\\d');
  // 生僻字（非 BMP）拆成两个代理码元，否则 Word 里是方块
  const out = rtfEscape('𠀀');
  assert.strictEqual((out.match(/\\u-?\d+\?/g) || []).length, 2);
});

test('groupSpecies：目/科按拉丁名排序，种按学名排序', () => {
  const g = groupSpecies(SAMPLE);
  const orders = g.map((o) => o.latin);
  assert.deepStrictEqual(orders, ['Lepidoptera', 'Orthoptera', '']);
  const lep = g[0];
  assert.deepStrictEqual(lep.familyList.map((f) => f.latin), ['Papilionidae', 'Pieridae']);
  assert.deepStrictEqual(lep.familyList[0].species.map((s) => s.latin), ['Graphium sarpedon', 'Papilio machaon']);
});

test('groupSpecies：没有分类的收进「分类待定」并排最后', () => {
  const g = groupSpecies(SAMPLE);
  const last = g[g.length - 1];
  assert.strictEqual(last.key, '');
  const fam = last.familyList[0];
  assert.strictEqual(fam.species.length, 1);
  assert.strictEqual(fam.species[0].cn, '未知种');
});

/** 把 \uN? 还原成字符，便于对着「人看的文本」断言 */
const decode = (s) =>
  String(s).replace(/\\u(-?\d+)\?/g, (_, n) => {
    const v = Number(n);
    return String.fromCharCode(v < 0 ? v + 65536 : v);
  });

test('buildRtf：拉丁名斜体、中文名不带斜体', () => {
  const rtf = buildRtf({ species: SAMPLE, title: '物种名录' });
  assert.match(rtf, /\\f1\\i Papilio machaon\\i0/);
  const line = rtf.split('\n').find((l) => l.includes('Papilio machaon'));
  assert.ok(line, '应能找到金凤蝶那一行');
  const before = line.split('\\f1\\i')[0]; // 斜体之前 = 编号 + 中文名
  assert.ok(!/\\i /.test(before), '中文名之前不该开斜体');
  assert.ok(/\\f0 /.test(before), '中文名走中文字体');
});

test('buildRtf：编号从 1 连续排到 N，不跳号', () => {
  const rtf = decode(buildRtf({ species: SAMPLE }));
  const plain = [...rtf.matchAll(/(?:^| )(\d+)\. /g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(plain, [1, 2, 3, 4, 5]);
});

test('buildRtf：统计行是「目 科 种」，分类待定不计入目数', () => {
  const rtf = decode(buildRtf({ species: SAMPLE }));
  assert.match(rtf, /共 2 目 3 科 5 种/);
});

test('buildRtf：整份文件不能有裸非 ASCII 字符（漏转义在 Word 里就是乱码）', () => {
  const rtf = buildRtf({ species: SAMPLE, title: '物种名录', note: '泰宁峨嵋峰 2026 春季调查' });
  const bad = [...rtf].filter((ch) => ch.charCodeAt(0) > 127);
  assert.deepStrictEqual(bad, [], `出现裸非 ASCII 字符：${bad.join('')}`);
});

test('buildRtf：大括号与 RTF 头尾成对', () => {
  const rtf = buildRtf({ species: SAMPLE });
  let depth = 0;
  let min = 0;
  for (let i = 0; i < rtf.length; i += 1) {
    const ch = rtf[i];
    if (ch === '\\') {
      i += 1; // 跳过被转义的字符
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < min) min = depth;
    }
  }
  assert.strictEqual(depth, 0, '括号必须闭合');
  assert.strictEqual(min, 0, '不能提前闭合');
  assert.ok(rtf.startsWith('{\\rtf1'));
  assert.ok(rtf.trimEnd().endsWith('}'));
});

test('buildRtf：空名录不崩，给出提示行', () => {
  const rtf = buildRtf({ species: [] });
  assert.match(rtf, /\\rtf1/);
  assert.match(rtf, /\\u/); // 提示文案也转义了
});

test('buildRtf：给了 indices 就在名录前插一张指数表，不给就不插', () => {
  const idx = {
    S: 5, N: 120,
    shannon: 1.5234, simpson: 0.7123, pielou: 0.9467, margalef: 0.8361,
    bergerParker: 0.325, chao1: 6.5, completeness: 0.7692,
    dominance: { counts: { dominant: 1, common: 2, rare: 2 } },
  };
  const withIdx = buildRtf({ species: SAMPLE, indices: idx });
  assert.match(withIdx, /\\trowd/, '应有表格行定义');
  const rows = (withIdx.match(/\\row/g) || []).length;
  assert.strictEqual(rows, 11, '表头 + 10 行指标');
  assert.match(withIdx, /Shannon-Wiener/);
  assert.match(withIdx, /1\.5234/, 'H′ 保留 4 位');
  assert.match(withIdx, /6\.5/, 'Chao1 保留 1 位');

  const without = buildRtf({ species: SAMPLE });
  assert.ok(!/\\trowd/.test(without), '没有指数时不该出现表格');
  assert.ok(!/Shannon-Wiener/.test(without));
});

test('buildRtf：指数为 0（空统计）时不插表，避免一堆 0 的表进报告', () => {
  const rtf = buildRtf({ species: SAMPLE, indices: { S: 0, N: 0 } });
  assert.ok(!/\\trowd/.test(rtf));
});

test('rtfTable2：列宽按累计 twip 写 cellx', () => {
  const { rtfTable2 } = require('../lib/species-rtf');
  const out = rtfTable2([['a', 'b'], ['c', 'd']], [1000, 2000]).join('\n');
  assert.match(out, /\\cellx1000\\cellx3000/);
  assert.strictEqual((out.match(/\\intbl/g) || []).length, 4, '两行两列共四个格');
});
