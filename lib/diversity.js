'use strict';

/**
 * diversity.js — 区系分析常用指标：多样性指数、优势度分级、物种累积与稀疏化曲线。
 *
 * 为什么单独一个模块：这些是「调查报告正文/附录」要写死的数字，算法口径必须能被
 * 单测钉住，不能散在 server.js 的统计流程里。本模块只吃 stats 那边的 record 数组，
 * 和文件系统、网络完全解耦。
 *
 * 口径（写报告时照这个写）：
 *   · 个体数 N = 照片张数。这是多度的代理值：同一种连拍多张会把 N 抬高，
 *     H′ 因此偏小（多样性被低估），报告里应写明「以照片数为个体数」。
 *   · 物种数 S 只算「已标注且分类解析成功」的记录，与统计页其余部分口径一致。
 *   · H′ 用自然对数（报告通用），Pielou 均匀度 = H′/lnS；S=1 时规定为 0。
 *   · Simpson 用 Gini-Simpson（1−Σp²，越大越多样）；另外给 1/D 备查。
 *   · Chao1 用偏差校正式 S + f1(f1−1) / (2(f2+1))，f1/f2 为只出现 1 次 / 2 次的物种数。
 *
 * 一条 record 与 stats.js 相同：{ labeled, taxon:{resolved,cn,latin,...}, taken, ... }
 */

const STATS = require('./stats');

/** 只取「已标注且分类解析成功」的记录 —— 未标注的图既不属于任何物种，也不该进分母 */
function usable(records) {
  return (records || []).filter((r) => r && r.labeled && r.taxon && r.taxon.resolved);
}

/**
 * 多度表：物种 → 照片数。
 * 归并键与 stats.speciesKey 一致（中文名 + 小写拉丁名），避免同名不同写法分家。
 */
function abundance(records) {
  const map = new Map();
  for (const r of usable(records)) {
    const key = STATS.speciesKey(r.taxon);
    const cell = map.get(key) || {
      key,
      cn: r.taxon.cn || '',
      latin: r.taxon.latin || '',
      n: 0,
    };
    if (!cell.cn && r.taxon.cn) cell.cn = r.taxon.cn;
    if (!cell.latin && r.taxon.latin) cell.latin = r.taxon.latin;
    cell.n += 1;
    map.set(key, cell);
  }
  const list = [...map.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const N = list.reduce((s, x) => s + x.n, 0);
  let f1 = 0;
  let f2 = 0;
  for (const x of list) {
    if (x.n === 1) f1 += 1;
    else if (x.n === 2) f2 += 1;
  }
  return { list, N, S: list.length, f1, f2 };
}

/** 保留 4 位小数：报告里的指数给太多位是假精度 */
function r4(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

/**
 * Chao1（偏差校正式）。
 * f2=0 时经典式会除以 0，所以统一用 S + f1(f1−1)/(2(f2+1))，
 * 这在 f2>0 时与经典式几乎相同，f2=0 时也不会炸。
 */
function chao1(S, f1, f2) {
  if (!S) return 0;
  return S + (f1 * (f1 - 1)) / (2 * (f2 + 1));
}

/**
 * 优势度分级（昆虫区系报告的常用切法，按个体数占比）：
 *   优势种 ≥ 5%，常见种 1%~5%，稀有种 < 1%
 * 阈值可调，但默认就按这个，报告里注明即可。
 */
function dominanceTiers(list, N, opt) {
  const hi = opt && Number.isFinite(opt.dominant) ? opt.dominant : 0.05;
  const lo = opt && Number.isFinite(opt.common) ? opt.common : 0.01;
  const tiers = { dominant: [], common: [], rare: [] };
  if (!N) return { ...tiers, counts: { dominant: 0, common: 0, rare: 0 } };
  for (const x of list) {
    const p = x.n / N;
    const item = { ...x, p: r4(p) };
    if (p >= hi) tiers.dominant.push(item);
    else if (p >= lo) tiers.common.push(item);
    else tiers.rare.push(item);
  }
  return {
    ...tiers,
    counts: {
      dominant: tiers.dominant.length,
      common: tiers.common.length,
      rare: tiers.rare.length,
    },
  };
}

/**
 * 一次算齐报告要用的所有指数。
 * @returns {object} 空数据时全部为 0，不产生 NaN/Infinity（导出到 RTF 会变成 "NaN"）
 */
function indices(records, opt) {
  return computeFromList(abundance(records).list, opt);
}

/**
 * 换个人口：已经有「物种 → 张数」的表时直接算（导出模块用，避免再造一遍 records）。
 * @param {Array<{cn?:string,latin?:string,n:number}>} list
 */
function indicesFromAbundance(list, opt) {
  const clean = (list || [])
    .filter((x) => x && Number.isFinite(x.n) && x.n > 0)
    .map((x) => ({ cn: x.cn || '', latin: x.latin || '', n: x.n, key: x.key || `${x.cn || ''} ${x.latin || ''}` }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return computeFromList(clean, opt);
}

/** 核心计算：只认「已排好序的多度表」 */
function computeFromList(list, opt) {
  const N = list.reduce((s, x) => s + x.n, 0);
  const S = list.length;
  let f1 = 0;
  let f2 = 0;
  for (const x of list) {
    if (x.n === 1) f1 += 1;
    else if (x.n === 2) f2 += 1;
  }
  if (!S || !N) {
    return {
      S: 0, N: 0,
      shannon: 0, simpson: 0, simpsonInv: 0, pielou: 0, margalef: 0, bergerParker: 0,
      chao1: 0, completeness: 0, f1: 0, f2: 0,
      dominance: { counts: { dominant: 0, common: 0, rare: 0 }, dominant: [], common: [], rare: [] },
      top: [],
      uniform: false,
    };
  }

  let H = 0;
  let sumSq = 0;
  for (const x of list) {
    const p = x.n / N;
    H -= p * Math.log(p);
    sumSq += p * p;
  }
  const simpson = 1 - sumSq;
  const ch = chao1(S, f1, f2);
  const dom = dominanceTiers(list, N, opt);
  return {
    S,
    N,
    shannon: r4(H),
    simpson: r4(simpson),
    simpsonInv: r4(sumSq > 0 ? 1 / sumSq : 0),
    // S=1 时 lnS=0，均匀度无定义，规定为 0（写作时说明「单种无法谈均匀度」）
    pielou: r4(S > 1 ? H / Math.log(S) : 0),
    margalef: r4(N > 1 ? (S - 1) / Math.log(N) : 0),
    bergerParker: r4(list[0].n / N),
    chao1: r4(ch),
    // 完整度：实际见到 / 估计应有。>90% 通常可以写「调查较充分」
    completeness: r4(ch > 0 ? S / ch : 0),
    f1,
    f2,
    dominance: dom,
    top: list.slice(0, 10).map((x) => ({ cn: x.cn, latin: x.latin, n: x.n, p: r4(x.n / N) })),
    // 各项完全相同（每个物种都只有一张）时，累积曲线会呈严格直线，前端可以提示一句
    uniform: list.every((x) => x.n === list[0].n),
  };
}

/**
 * 稀疏化曲线（rarefaction）的期望物种数。
 *
 *   E[S_k] = Σ_i [ 1 − C(N−n_i, k) / C(N, k) ]
 *
 * 直接算组合数会溢出，所以用递推比值：
 *   r_i(k) = r_i(k−1) · (N−n_i−k+1) / (N−k+1)，r_i(0)=1
 * k > N−n_i 时该物种在第 k 个个体前必然已被抽到，r_i 记 0（贡献恒为 1），
 * 剩下的采样点直接累加，省掉整段无用循环。
 *
 * @param {number[]} counts 各物种个体数
 * @param {number[]} points 升序的采样个体数（末尾一般等于 N）
 * @returns {Array<{n:number,s:number}>}
 */
function rarefaction(counts, points) {
  const ks = (points || []).filter((k) => Number.isFinite(k) && k > 0).sort((a, b) => a - b);
  const N = (counts || []).reduce((s, x) => s + x, 0);
  if (!ks.length || !N) return ks.map((k) => ({ n: k, s: 0 }));
  const sums = new Array(ks.length).fill(0);
  const kmax = ks[ks.length - 1];

  for (const ni of counts) {
    if (!(ni > 0)) continue;
    // 该物种在 k > N−ni 之后必然被抽到：先算出临界点，之后的采样点直接 +1
    const certainFrom = N - ni + 1; // k >= certainFrom 时 r=0
    let r = 1;
    let ki = 0;
    for (let k = 1; k <= kmax; k += 1) {
      if (k < certainFrom) {
        const num = N - ni - (k - 1);
        const den = N - (k - 1);
        r = den > 0 ? (r * num) / den : 0;
      } else {
        r = 0;
      }
      // 把落在该 k 上的采样点都结算掉（ks 可能有重复）
      while (ki < ks.length && ks[ki] === k) {
        sums[ki] += 1 - r;
        ki += 1;
      }
      if (r === 0 && ki >= ks.length) break;
    }
    // 循环因 k 上限提前结束时，剩余采样点（k < certainFrom 的那些不会剩下）
    while (ki < ks.length) {
      sums[ki] += 1;
      ki += 1;
    }
  }
  return ks.map((k, i) => ({ n: k, s: r4(Math.min(sums[i], counts.length)) }));
}

/** 把一条曲线降采样到至多 max 个点（含首尾），前端画 SVG 不必吃几千个点 */
function decimate(points, max) {
  const cap = max || 120;
  if (!points || points.length <= cap) return points || [];
  const out = [];
  const step = (points.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * 物种累积曲线。
 *
 * observed：按拍摄时间排序后逐张累加，反映「实际怎么见到的」（受采集强度、季节影响，常呈阶梯）。
 * rarefaction：假设个体随机抽取时的期望物种数，比 observed 高是正常现象（实际采集有聚集）。
 * byDay：按采样日聚合，用于「每天新增多少种」，也是报告里画累积图的常见横轴。
 *
 * @param {Array} records
 * @param {object} [opt] { maxPoints }
 */
function accumulation(records, opt) {
  const o = opt || {};
  const recs = (records || []).filter((r) => r && r.taken);
  recs.sort((a, b) => a.taken - b.taken || String(a.stem || '').localeCompare(String(b.stem || '')));

  const seen = new Set();
  const observed = [];
  let n = 0;
  for (const r of recs) {
    n += 1;
    if (r.labeled && r.taxon && r.taxon.resolved) seen.add(STATS.speciesKey(r.taxon));
    observed.push({ n, s: seen.size });
  }

  // 按日：同一天的多张合并成一个采样单元
  const byDayMap = new Map();
  const seenDay = new Set();
  for (const r of recs) {
    const key = `${r.taken.getFullYear()}-${String(r.taken.getMonth() + 1).padStart(2, '0')}-${String(r.taken.getDate()).padStart(2, '0')}`;
    let cell = byDayMap.get(key);
    if (!cell) {
      cell = { d: key, photos: 0, newSpecies: 0, cumSpecies: 0 };
      byDayMap.set(key, cell);
    }
    cell.photos += 1;
    if (r.labeled && r.taxon && r.taxon.resolved) {
      const k = STATS.speciesKey(r.taxon);
      if (!seenDay.has(k)) {
        seenDay.add(k);
        cell.newSpecies += 1;
      }
    }
  }
  let cum = 0;
  const byDay = [...byDayMap.values()]
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .map((c) => {
      cum += c.newSpecies;
      return { ...c, cumSpecies: cum };
    });

  // 稀疏化：横轴按个体数取点，末端补上 N 本身
  const { list, N } = abundance(records);
  const counts = list.map((x) => x.n);
  const want = Math.min(60, Math.max(2, N));
  const points = [];
  for (let i = 1; i <= want; i += 1) points.push(Math.round((i / want) * N) || 1);
  points[points.length - 1] = N;
  const rare = N ? rarefaction(counts, [...new Set(points)].sort((a, b) => a - b)) : [];

  const maxPts = o.maxPoints || 120;
  return {
    N,
    S: list.length,
    observed: decimate(observed, maxPts),
    rarefaction: decimate(rare, maxPts),
    byDay: byDay.slice(-maxPts),
    dayCount: byDay.length,
  };
}

module.exports = { abundance, indices, indicesFromAbundance, rarefaction, accumulation, dominanceTiers, chao1, decimate };
