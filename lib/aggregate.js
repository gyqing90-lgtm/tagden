'use strict';

function normLatin(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // 去掉亚属括号
    .replace(/\s+/g, ' ')
    .trim();
}

function genusOf(latin) {
  return String(latin || '').trim().split(/\s+/)[0] || '';
}

/**
 * 中文名归一化：去掉括号里的补充说明（「山麻雀（成鸟）」）、空白和间隔号。
 * 百度这类站点只给中文名，靠它跟别家的学名结果对齐。
 */
function normCn(s) {
  return String(s || '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[\s·・]+/g, '')
    .trim();
}

/**
 * 把各站点的 Top-N 合并成一张共识表。
 * 每个站点内部先把 Top5 置信度归一化（消除不同站点分值口径差异），
 * 再按「有多少站点提到它」+「归一化权重之和」排序。
 *
 * 分两遍走的原因：有些站点（百度动物/植物识别）只回中文名、没有学名。
 * 第一遍先让有学名的建行并登记「中文名 → 行」；第二遍只有中文名的按中文名
 * 挂到已有行上，挂不上才自建 cn: 行 —— 否则同一只山麻雀会被拆成两行。
 */
function aggregate(resultsBySite, topN = 5) {
  const activeSites = Object.keys(resultsBySite).filter(
    (k) =>
      resultsBySite[k]?.ok &&
      resultsBySite[k].items?.length &&
      // 同引擎镜像站点（文浩识蝶复用识蛾结果）只展示，不重复计票
      !resultsBySite[k].mirrorOf,
  );

  const acc = new Map();
  const cnIndex = new Map(); // 中文名 → 行 key（只收有学名的行）
  const pending = []; // 只有中文名的候选，留到第二遍

  const attach = (row, site, it, weight) => {
    const raw = Math.max(0, Number(it.score) || 0);
    const prev = row.bySite[site];
    // 同一个站点重复提到同一个物种时只算一票，取更高的那个分
    if (!prev) row.support += 1;
    row.bySite[site] = {
      // 留 4 位：百度这类 softmax 尾巴是 0.0004，只留 1 位就被抹成 0，
      // 前端 fmtScore() 会把它显示成「<0.1」而不是「0.0」
      score: Math.round((prev ? Math.max(prev.score, raw) : raw) * 10000) / 10000,
      weight: Math.round((prev ? prev.weight + weight : weight) * 1000) / 1000,
      rank: prev ? Math.min(prev.rank || 99, it.rank || 99) : it.rank,
    };
    if (!prev) row.weight += weight;
    if (!row.cn && it.cn) row.cn = it.cn;
    if (!row.latin && it.latin) row.latin = it.latin;
  };

  const rowFor = (key, it) => {
    let row = acc.get(key);
    if (!row) {
      row = { key, latin: it.latin || '', cn: it.cn || '', bySite: {}, support: 0, weight: 0 };
      acc.set(key, row);
    }
    return row;
  };

  for (const site of activeSites) {
    const items = resultsBySite[site].items.slice(0, topN);
    const total = items.reduce((s, it) => s + Math.max(0, Number(it.score) || 0), 0);
    const denom = total > 0 ? total : items.length || 1;
    for (const it of items) {
      const weight = total > 0 ? Math.max(0, Number(it.score) || 0) / denom : 1 / denom;
      const latinKey = normLatin(it.latin);
      if (latinKey) {
        attach(rowFor(latinKey, it), site, it, weight);
        const ckey = normCn(it.cn);
        if (ckey && !cnIndex.has(ckey)) cnIndex.set(ckey, latinKey);
      } else if (normCn(it.cn)) {
        pending.push({ site, it, weight });
      }
    }
  }

  for (const { site, it, weight } of pending) {
    const ckey = normCn(it.cn);
    const hit = cnIndex.get(ckey);
    if (hit) {
      attach(acc.get(hit), site, it, weight);
    } else {
      const key = `cn:${ckey}`;
      cnIndex.set(ckey, key);
      attach(rowFor(key, it), site, it, weight);
    }
  }

  const siteCount = activeSites.length || 1;
  const rows = [...acc.values()].map((r) => {
    const avgWeight = r.weight / siteCount;        // 0~1：平均归一化置信度
    const supportRatio = r.support / siteCount;    // 0~1：提及该物种的站点比例
    return {
      ...r,
      genus: genusOf(r.latin),
      // 综合得分：主要看置信度，其次看有多少站点独立提到它
      pct: Math.round(100 * (0.7 * avgWeight + 0.3 * supportRatio)),
      unanimous: r.support === siteCount && siteCount > 1,
    };
  });
  rows.sort((a, b) => b.pct - a.pct || b.support - a.support || b.weight - a.weight);

  // 属级一致性（种级分歧时仍有参考价值）
  const genusVotes = new Map();
  for (const site of activeSites) {
    const top = resultsBySite[site].items[0];
    if (!top) continue;
    const g = genusOf(top.latin);
    if (!g) continue;
    genusVotes.set(g, (genusVotes.get(g) || 0) + 1);
  }
  const genusRank = [...genusVotes.entries()].sort((a, b) => b[1] - a[1]);
  const genusConsensus = genusRank.length
    ? { genus: genusRank[0][0], votes: genusRank[0][1], total: activeSites.length }
    : null;

  const best = rows[0] || null;
  return {
    sites: activeSites,
    siteCount: activeSites.length,
    rows,
    best,
    genusConsensus,
    verdict: buildVerdict(best, genusConsensus, activeSites.length),
  };
}

function buildVerdict(best, genusConsensus, siteCount) {
  if (!best) return '无可用结果';
  const name = `${best.cn ? best.cn + ' ' : ''}${best.latin}`;
  if (siteCount <= 1) {
    return `${name}（仅 1 个站点参与，未经交叉验证）`;
  }
  if (best.support >= Math.min(3, siteCount)) {
    return `${best.support}/${siteCount} 个站点一致指向 ${name}`;
  }
  if (genusConsensus && genusConsensus.votes >= Math.ceil(siteCount / 2) && genusConsensus.votes > 1) {
    return `种级存在分歧，但 ${genusConsensus.votes}/${siteCount} 个站点一致指向 ${genusConsensus.genus} 属（首选 ${name}）`;
  }
  return `各站点结论不一致，最高得票：${name}（${best.support}/${siteCount}）`;
}

module.exports = { aggregate, normLatin, normCn, genusOf, buildVerdict };
