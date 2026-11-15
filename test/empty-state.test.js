/**
 * 空状态框的样式回归。
 *
 * 背景：`.empty` 为了放插画改成了 display:flex，而 [hidden] 对 flex 容器无效，
 * 结果 JS 里 hidden=true 也压不住 —— 标注页、统计页、归档页底下一直铺着一条虚线大框，
 * 没写文案时只剩一个灰色图标，看起来像「图片加载失败」。
 *
 * 这里守住两件事：① 有 display:flex 的 .empty 必须配 `.empty[hidden]`；
 * ② index.html 里每个 .empty 元素都得能被 hidden 关掉（不能是纯装饰占位）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

test('.empty 自带 display:flex 时必须显式压掉 [hidden]', () => {
  // 抓 `.empty { ... }` 这条基础规则（不含伪类/属性选择器）
  const m = css.match(/^\.empty\s*\{([^}]*)\}/m);
  assert.ok(m, '.empty 基础规则应该在 style.css 里');
  if (/display:\s*(flex|grid)/.test(m[1])) {
    assert.match(
      css,
      /\.empty\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
      'flex 容器的 [hidden] 要显式写 display:none !important，否则 JS 里藏不掉'
    );
  }
});

test('空的 .empty 不留只有图标的大空框', () => {
  assert.match(css, /\.empty:empty\s*\{[^}]*display:\s*none/, '没填内容的 .empty 应该不渲染');
});

test('index.html 里的 .empty 元素都靠 hidden 控制显隐', () => {
  const tags = [...html.matchAll(/<div[^>]*class="empty"[^>]*>/g)].map((x) => x[0]);
  assert.ok(tags.length >= 3, `应该能找到多个空状态框，实际 ${tags.length}`);
  for (const tag of tags) {
    assert.match(tag, /\shidden(\s|>|=)/, `${tag} 缺 hidden 初值，一进页面就会露出来`);
  }
});
