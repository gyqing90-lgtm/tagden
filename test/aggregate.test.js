'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregate } = require('../lib/aggregate');

const site = (items) => ({ ok: true, items });

test('同一学名跨站合并为一行，票数按站点累加', () => {
  const agg = aggregate({
    a: site([{ cn: '碧翠凤蝶', latin: 'Papilio bianor', score: 0.9, rank: 1 }]),
    b: site([{ cn: '碧凤蝶', latin: 'Papilio bianor', score: 0.8, rank: 1 }]),
  });

  assert.equal(agg.rows.length, 1);
  assert.equal(agg.rows[0].support, 2);
  assert.equal(agg.siteCount, 2);
  // 第一站的中文名先占位，后面的同名学名不再覆盖
  assert.equal(agg.rows[0].cn, '碧翠凤蝶');
  assert.equal(agg.rows[0].genus, 'Papilio');
  assert.match(agg.verdict, /2\/2/);
});

test('只有中文名的站点会挂到已有学名行，而不是新建一行', () => {
  const agg = aggregate({
    a: site([{ cn: '山麻雀', latin: 'Passer cinnamomeus', score: 1, rank: 1 }]),
    b: site([{ cn: '山麻雀', latin: '', score: 0.6, rank: 1 }]),
  });

  assert.equal(agg.rows.length, 1);
  assert.equal(agg.rows[0].support, 2);
  assert.equal(agg.rows[0].latin, 'Passer cinnamomeus');
});

test('同引擎镜像站只展示、不重复计票', () => {
  const agg = aggregate({
    a: site([{ latin: 'Papilio bianor', score: 1, rank: 1 }]),
    b: { ...site([{ latin: 'Papilio bianor', score: 1, rank: 1 }]), mirrorOf: 'a' },
  });

  assert.equal(agg.siteCount, 1);
  assert.equal(agg.rows[0].support, 1);
});

test('失败的站点不进 siteCount', () => {
  const agg = aggregate({
    a: site([{ latin: 'Papilio bianor', score: 1, rank: 1 }]),
    b: { ok: false, items: [] },
  });

  assert.equal(agg.siteCount, 1);
  assert.equal(agg.rows[0].support, 1);
});
