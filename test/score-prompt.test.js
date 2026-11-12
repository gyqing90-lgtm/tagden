'use strict';
/**
 * AI 语义评分的提示词必须「选什么类群就评什么」。
 *
 * 事故：选了「植物」，旧模板里却写着「若画面里只有昆虫或只有植物，必须判为无」，
 * 4B 级本地模型读到「昆虫」就答「画面里没有昆虫」→ AI 分直接 0。
 * 这里把「每个类群只出现自己的措辞」钉死，谁改模板都得过这一关。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  buildPrompt, buildPromptBatch, resolveTaxon, canStrict, TAXA, SUBJECTS,
} = require('../lib/score-ai');

test('植物提示词里不出现昆虫字样（通用与严格两套）', () => {
  for (const strict of [false, true]) {
    const p = buildPrompt('植物', strict);
    assert.ok(!/昆虫/.test(p), `strict=${strict} 的植物提示词里混进了「昆虫」：\n${p}`);
    assert.ok(/植物/.test(p), '植物提示词要明确评分对象是植物');
    assert.ok(/花/.test(p) && /叶/.test(p), '植物提示词要给出花/叶这类鉴定部位');
  }
});

test('植物严格模式用的是植物自己的判据', () => {
  const p = buildPrompt('植物', true);
  assert.ok(p.includes('专用植物检测模式'));
  assert.ok(/叶脉|叶形/.test(p));
  assert.ok(!/专用昆虫检测模式/.test(p));
});

test('昆虫严格模式仍然是昆虫那套（触角/鞘翅/非昆虫节肢动物）', () => {
  const p = buildPrompt('昆虫', true);
  assert.ok(p.includes('专用昆虫检测模式'));
  assert.ok(/触角/.test(p) && /鞘翅/.test(p));
  assert.ok(/蜘蛛/.test(p));
});

test('鸟类不会被套上昆虫的鉴定部位', () => {
  const p = buildPrompt('鸟类', false);
  assert.ok(/鸟/.test(p));
  assert.ok(!/鞘翅|触角|复眼/.test(p), '鸟类提示词里不该出现昆虫部位');
});

test('通用模式下不出现某单一类群当作判据', () => {
  const p = buildPrompt('通用(自动判断)', false);
  assert.ok(/生物主体/.test(p));
  assert.ok(!/昆虫|鸟类|兽类/.test(p), '通用判据不该点名具体类群');
});

test('严格模式对「通用」不生效（没有专属判据）', () => {
  assert.equal(canStrict('通用(自动判断)'), false);
  assert.equal(canStrict('植物'), true);
  assert.ok(!buildPrompt('通用(自动判断)', true).includes('专用'));
});

test('类群写法容错：长标签 / 脏值都收敛到合法类群', () => {
  assert.equal(resolveTaxon('植物(花、果、叶或整株)'), '植物');
  assert.equal(resolveTaxon(' 植物 '), '植物');
  assert.equal(resolveTaxon('鸟类'), '鸟类');
  assert.equal(resolveTaxon('两栖爬行动物'), '两栖爬行动物');
  assert.equal(resolveTaxon('通用(自动判断)'), '通用(自动判断)');
  assert.equal(resolveTaxon('自动判断'), '通用(自动判断)');
  // 认不出来时返回空串，由上层决定兜底，绝不静默退回昆虫
  assert.equal(resolveTaxon('乱写的类群'), '');
  assert.equal(resolveTaxon(''), '');
});

test('TAXA 清单与 SUBJECTS 一致，前端下拉拿到的是类群名', () => {
  assert.deepEqual(TAXA, Object.keys(SUBJECTS));
  assert.ok(TAXA.includes('昆虫') && TAXA.includes('植物'));
});

test('批量提示词按类群走，并约束数组长度', () => {
  const p = buildPromptBatch(3, '植物', false);
  assert.ok(!/昆虫/.test(p));
  assert.ok(p.includes('长度为 3'));
  assert.ok(p.includes('"idx":1'));
  // 单张的尾巴（只输出一个对象）不能带进批量模板
  assert.ok(!p.includes('只输出一个JSON对象'));
});

test('每张结果都要求鉴定部位，植物也一样', () => {
  assert.ok(buildPrompt('植物', false).includes('key_parts'));
  assert.ok(buildPromptBatch(2, '植物', true).includes('key_parts'));
});
