/**
 * 深色模式回归：这些控件早期把底色写死成 #fff / 奶油色，深色下一开就是一片白。
 * 其中最要命的是左栏「相册端」——白底白字，字直接看不见。
 *
 * 这里只守「必须存在深色覆盖」这一条，颜色值好不好看不在测试范围内。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 深色块里出现过的选择器（去掉 html[data-theme="dark"] 前缀）
const darkSelectors = new Set();
for (const m of css.matchAll(/(html\[data-theme="dark"\][^{}]*)\{/g)) {
  for (const one of m[1].split(',')) {
    darkSelectors.add(one.trim().replace(/^html\[data-theme="dark"\]\s*/, '').trim());
  }
}

const MUST = [
  ['.seg button', '左栏「本机端 / 相册端」未选中那个按钮（白底白字）'],
  ['.pathbox button', '路径框右边的 ↵ 按钮'],
  ['.places button', '桌面 / 图片 / 下载 / 文档 胶囊'],
  ['.pager', '翻页条'],
  ['.card.folder .thumb.fold', '文件夹卡片的奶油底板'],
  ['.upbar', '顶部「发现新版本」条'],
  ['.preview', '详情面板的照片底板'],
  ['.chip.off', '未选中的筛选胶囊'],
  ['.cand', '候选物种卡片'],
];

test('写死浅底的控件都要有深色覆盖', () => {
  const missing = MUST.filter(([sel]) => !darkSelectors.has(sel)).map(([sel, why]) => `${sel}（${why}）`);
  assert.deepStrictEqual(missing, [], `这些控件缺深色覆盖：\n  ${missing.join('\n  ')}`);
});

test('深色变量齐全（缺一个就有一片区域沿用浅色）', () => {
  // 深色变量分两块（热力图色阶在统计页那一段单独定义），合起来看
  const blocks = [...css.matchAll(/html\[data-theme="dark"\]\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
  assert.ok(blocks.trim(), '应该有 html[data-theme="dark"] 的变量块');
  for (const v of ['--bg', '--card', '--line', '--line-soft', '--ink', '--ink-2', '--ink-3', '--green', '--green-l']) {
    assert.match(blocks, new RegExp(`${v}:`), `深色变量缺 ${v}`);
  }
});

test('柱状图的列有宽度上限（只有 1 个年份时不会铺满整行）', () => {
  const rule = css.match(/\.st-col\s*\{([^}]*)\}/);
  assert.ok(rule, '.st-col 规则应该在');
  assert.match(rule[1], /max-width:/, 'flex:1 的柱子必须给 max-width，否则单条数据会撑满整行');
});
