'use strict';
/**
 * stats.js — 多维统计（移植自 bio-file/stats.py，纯函数、零依赖）
 *
 * 这是把「物种看图统计器(bio-file)」的统计模块整合进「标注工坊(tagden)」的核心：
 * tagden 已经能把图片标注成「中文名 + 学名」并解析出完整的「界门纲目科属」，
 * 本模块只负责在那一堆记录上做统计，和具体的数据来源解耦。
 *
 * 一条 record 约定：
 *   {
 *     labeled: bool,                 // 是否已被标注（有中文名或学名）
 *     taxon:  { resolved, kingdom, kingdomCn, phylum, phylumCn, class, classCn,
 *               order, orderCn, family, familyCn, genus, genusCn, cn, latin },
 *     taken:  Date | null,           // 拍摄时间（来自 EXIF，无则文件修改时间）
 *     regionLabel: string,           // 地区（GPS 反查的省·市，或所在子文件夹）
 *     project: string,               // 顶层子文件夹（根目录直接放的图算「根目录」）
 *     folder: string,                // 该图所在文件夹（相对根）
 *     stem: string                   // 文件名（去扩展名）
 *   }
 */

/* ---------------- 小工具 ---------------- */

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function speciesKey(t) {
  return `${t.cn || ''} ${norm(t.latin) || ''}`;
}

const RANKS = [
  ['界', 'kingdom'],
  ['门', 'phylum'],
  ['纲', 'class'],
  ['目', 'order'],
  ['科', 'family'],
  ['属', 'genus'],
];

/** 未鉴定清单最多回多少条（前端只拿来铺缩略图，不必给全） */
const LIST_CAP = 200;

// 显示用：有中文就用「中文 拉丁」，否则只用拉丁
function rankLabel(latin, cn) {
  if (latin && cn && cn !== '未知') return `${cn} ${latin}`;
  return latin || cn || '未知';
}

function season(month) {
  if (month >= 3 && month <= 5) return '春季';
  if (month >= 6 && month <= 8) return '夏季';
  if (month >= 9 && month <= 11) return '秋季';
  return '冬季';
}

/* ---------------- 层级计数：界/门/纲/目/科/属/种 ---------------- */

function levelCounts(records) {
  const labeled = records.filter((r) => r.labeled);
  const res = labeled.filter((r) => r.taxon && r.taxon.resolved);
  const out = {};
  for (const [zh, attr] of RANKS) {
    const set = new Set();
    for (const r of res) {
      const v = r.taxon[attr];
      if (v) set.add(v);
    }
    out[zh] = set.size;
  }
  const sp = new Set();
  for (const r of res) sp.add(speciesKey(r.taxon));
  out['种'] = sp.size;
  out['已鉴定'] = labeled.length;
  out['未鉴定'] = records.length - labeled.length;
  out['已标注未解析'] = labeled.length - res.length;
  return out;
}

/* ---------------- 单维度分布（只统计已鉴定） ---------------- */

function dimKeyName(r, dim) {
  const t = r.taxon || {};
  if (dim === 'time_year') {
    const k = r.taken ? String(r.taken.getFullYear()) : '未知时间';
    return { key: k, name: k };
  }
  if (dim === 'time_month') {
    const k = r.taken
      ? `${r.taken.getFullYear()}年${String(r.taken.getMonth() + 1).padStart(2, '0')}月`
      : '未知时间';
    return { key: k, name: k };
  }
  if (dim === 'time_season') {
    const k = r.taken ? `${r.taken.getFullYear()} ${season(r.taken.getMonth() + 1)}` : '未知时间';
    return { key: k, name: k };
  }
  if (dim === 'region') {
    const k = r.regionLabel || '未知地区';
    return { key: k, name: k };
  }
  if (dim === 'species') {
    const k = t.cn || t.latin || r.stem || '未命名';
    return { key: k, name: k };
  }
  if (dim === 'project') {
    const k = r.project || '根目录';
    return { key: k, name: k };
  }
  if (dim === 'folder') {
    const k = r.folder || '根目录';
    return { key: k, name: k };
  }
  if (dim === 'kingdom') return { key: t.kingdom || '未知', name: rankLabel(t.kingdom, t.kingdomCn) };
  if (dim === 'class') return { key: t.class || '未知', name: rankLabel(t.class, t.classCn) };
  if (dim === 'family') return { key: t.family || '未知', name: rankLabel(t.family, t.familyCn) };
  if (dim === 'genus') return { key: t.genus || '未知', name: rankLabel(t.genus, t.genusCn) };
  return { key: '', name: '' };
}

function byDimension(records, dim) {
  const cnt = new Map();
  for (const r of records) {
    const { key, name } = dimKeyName(r, dim);
    if (!key) continue;
    const cur = cnt.get(key);
    if (!cur) cnt.set(key, { name, count: 0 });
    cnt.get(key).count += 1;
  }
  return [...cnt.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/* ---------------- 分类树：界 → 门 → … → 属 → 种 ---------------- */

function buildTree(records) {
  const root = { name: '全部', count: 0, children: new Map() };
  for (const r of records) {
    if (!r.labeled) continue; // 未鉴定不进分类树，单独在「未鉴定分组」里统计
    let node = root;
    node.count += 1;
    if (r.taxon && r.taxon.resolved) {
      for (const [, attr] of RANKS) {
        const v = r.taxon[attr];
        if (!v) continue;
        const cn = r.taxon[attr + 'Cn'];
        const label = rankLabel(v, cn);
        let child = node.children.get(v); // 按拉丁名归并，避免「Animalia」与「动物界 Animalia」分家
        if (!child) {
          child = { name: label, count: 0, children: new Map(), leaf: false };
          node.children.set(v, child);
        }
        child.count += 1;
        node = child;
      }
      const spk = r.taxon.cn || r.taxon.latin || '未命名';
      const leafKey = `__sp__${spk}`;
      let leaf = node.children.get(leafKey);
      if (!leaf) {
        leaf = { name: spk, count: 0, children: new Map(), leaf: true };
        node.children.set(leafKey, leaf);
      }
      leaf.count += 1;
    } else {
      // 已标注但分类没解析出来的，单独挂一个节点，不混进正式分类树
      let un = node.children.get('__unresolved__');
      if (!un) {
        un = { name: '已标注·未解析分类', count: 0, children: new Map(), leaf: false };
        node.children.set('__unresolved__', un);
      }
      un.count += 1;
      const spk = r.taxon.cn || r.taxon.latin || '未命名';
      let leaf = un.children.get(spk);
      if (!leaf) {
        leaf = { name: spk, count: 0, children: new Map(), leaf: true };
        un.children.set(spk, leaf);
      }
      leaf.count += 1;
    }
  }
  const toArr = (n) => ({
    name: n.name,
    count: n.count,
    leaf: n.leaf,
    children: [...n.children.values()].map(toArr).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)),
  });
  return toArr(root);
}

/* ---------------- 未鉴定分组（只给数字 + 按文件夹分组） ---------------- */

function unidentifiedGroup(records) {
  const map = new Map();
  const list = [];
  let count = 0;
  for (const r of records) {
    if (r.labeled) continue;
    const f = r.folder || '根目录';
    map.set(f, (map.get(f) || 0) + 1);
    count += 1;
    // list 只是给前端铺缩略图看的，图多的文件夹可能上千张，别整个塞过去
    if (list.length < LIST_CAP) list.push({ folder: f, stem: r.stem, path: r.path || '' });
  }
  const byFolder = [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([folder, count]) => ({ folder, count }));
  return { count, byFolder, list, listCapped: count > list.length };
}

/* ---------------- 维度清单（与 bio-file 对齐） ---------------- */

// [dim, 中文名]，顺序即前端标签页顺序
const DIMENSIONS = [
  ['species', '按物种'],
  ['folder', '按文件夹'],
  ['region', '按地区'],
  ['time_season', '按季节'],
  ['time_year', '按年份'],
  ['time_month', '按月份'],
  ['kingdom', '按界'],
  ['class', '按纲'],
  ['family', '按科'],
  ['genus', '按属'],
];

module.exports = {
  levelCounts,
  byDimension,
  buildTree,
  unidentifiedGroup,
  season,
  DIMENSIONS,
  RANKS,
  speciesKey,
  rankLabel,
};
