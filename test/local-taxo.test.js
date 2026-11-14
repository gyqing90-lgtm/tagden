'use strict';
/**
 * 本地物种名录（lib/local-taxo.js）的回归测试。
 *
 * 名字归一那部分是纯函数，随时可测；真正查库的部分要用户本机有
 * Chinese-Latin 的 backbone 数据库，没有就跳过（不给别人制造红色失败）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const LOCAL = require('../lib/local-taxo');

test('学名削成名录里的写法：去命名人、去年份、去亚属括号', () => {
  assert.ok(LOCAL.nameVariants('Papilio bianor Cramer, 1777').includes('Papilio bianor'));
  assert.ok(LOCAL.nameVariants('Papilio (Achillides) bianor').includes('Papilio bianor'));
  // 只给属名时也能查
  assert.deepStrictEqual(LOCAL.nameVariants('papilio'), ['Papilio']);
  // 中文名/空值不该造出拉丁查询
  assert.deepStrictEqual(LOCAL.nameVariants('中华虎凤蝶'), []);
  assert.deepStrictEqual(LOCAL.nameVariants(''), []);
});

test('三个阶段名按 二名法 → 属名 兜底', () => {
  const v = LOCAL.nameVariants('Luehdorfia chinensis leei');
  assert.strictEqual(v[0], 'Luehdorfia chinensis');
  assert.ok(v.includes('Luehdorfia'));
});

const dbGuess = (() => {
  try {
    const s = LOCAL.init({});
    const st = LOCAL.status();
    if (st.ok) return st.dbFile;
    // 没自动找到时，允许用环境变量再试
    if (process.env.TAGDEN_LOCAL_TAXO) {
      LOCAL.init({ dir: process.env.TAGDEN_LOCAL_TAXO });
      const st2 = LOCAL.status();
      if (st2.ok) return st2.dbFile;
    }
    return '';
  } catch {
    return '';
  }
})();

test('本地能解析出界门纲目科属（有 backbone 数据库时）', { skip: !dbGuess }, () => {
  const ranks = LOCAL.resolve('Papilio bianor Cramer, 1777', '');
  assert.ok(ranks, '应该能在本地名录里命中碧翠凤蝶');
  assert.strictEqual(ranks.genus.latin, 'Papilio');
  assert.strictEqual(ranks.genus.cn, '凤蝶属');
  assert.strictEqual(ranks.family.latin, 'Papilionidae');
  assert.strictEqual(ranks.family.cn, '凤蝶科');
  assert.strictEqual(ranks.order.cn, '鳞翅目');
  assert.strictEqual(ranks.class.cn, '昆虫纲');
  assert.strictEqual(ranks.phylum.cn, '节肢动物门');
  assert.strictEqual(ranks.kingdom.cn, '动物界');
});

test('只有中文名时：名字唯一才认，重名宁可联网', { skip: !dbGuess }, () => {
  const ok = LOCAL.resolve('', '中华虎凤蝶');
  assert.ok(ok && ok.genus && ok.genus.latin === 'Luehdorfia');
  // 名录里没有的名字必须返回 null，交给 iNat/GBIF
  assert.strictEqual(LOCAL.resolve('', '这个名字肯定不存在'), null);
});

test('查不到就是 null，不抛错', () => {
  assert.strictEqual(LOCAL.resolve('', ''), null);
  assert.doesNotThrow(() => LOCAL.resolve('Notagenus notspecies', ''));
});

test('数据库路径与文件状态自洽', { skip: !dbGuess }, () => {
  const st = LOCAL.status();
  assert.ok(fs.existsSync(st.dbFile));
  assert.ok(path.isAbsolute(st.dbFile));
  assert.ok(st.size > 0);
});
