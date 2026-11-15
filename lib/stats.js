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
    // 没有 GPS 的图 regionLabel 是空串：不能算「未知地区」，那会让人以为
    // 这些图有坐标只是没认出来。用户要的是「不统计」，所以直接跳过。
    const k = r.regionLabel || '';
    if (!k) return { key: '', name: '' };
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
          child = { name: label, latin: v, cn: cn || '', count: 0, children: new Map(), leaf: false };
          node.children.set(v, child);
        }
        child.count += 1;
        node = child;
      }
      const spk = r.taxon.cn || r.taxon.latin || '未命名';
      const leafKey = `__sp__${spk}`;
      let leaf = node.children.get(leafKey);
      if (!leaf) {
        leaf = { name: spk, latin: r.taxon.latin || '', cn: r.taxon.cn || '', count: 0, children: new Map(), leaf: true };
        node.children.set(leafKey, leaf);
      }
      leaf.count += 1;
    } else {
      // 已标注但分类没解析出来的，单独挂一个节点，不混进正式分类树
      let un = node.children.get('__unresolved__');
      if (!un) {
        un = { name: '已标注·未解析分类', latin: '', cn: '', count: 0, children: new Map(), leaf: false };
        node.children.set('__unresolved__', un);
      }
      un.count += 1;
      const spk = r.taxon.cn || r.taxon.latin || '未命名';
      let leaf = un.children.get(spk);
      if (!leaf) {
        leaf = { name: spk, latin: r.taxon.latin || '', cn: r.taxon.cn || '', count: 0, children: new Map(), leaf: true };
        un.children.set(spk, leaf);
      }
      leaf.count += 1;
    }
  }
  const toArr = (n) => ({
    name: n.name,
    latin: n.latin || '',
    cn: n.cn || '',
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

/* ---------------- 口径覆盖度（给仪表盘顶部的提示条用） ----------------
 * 关键约定：没有 GPS 的图不进「地区」统计，所以这里要把「有坐标 / 没坐标」
 * 两张数都报给前端，让用户一眼看出地区卡为什么只统计了一部分图。
 */

function coverage(records) {
  let gps = 0;
  let timeExif = 0;
  let timeFile = 0;
  for (const r of records) {
    if (r.gps) gps += 1;
    if (r.takenSrc === 'file') timeFile += 1;
    else if (r.taken) timeExif += 1;
  }
  return {
    total: records.length,
    gps,
    noGps: records.length - gps,
    timeExif,
    timeFile,
  };
}

/* ---------------- 摄影时间线：年 / 月 / 时段 ----------------
 * 全部照片参与（含未鉴定），因为「哪年拍了多少张」和鉴定无关。
 */

const HOURS = [
  ['凌晨', 0, 5],
  ['清晨', 5, 8],
  ['上午', 8, 11],
  ['中午', 11, 14],
  ['下午', 14, 17],
  ['傍晚', 17, 19],
  ['夜间', 19, 24],
];

function hourBand(h) {
  for (const [name, from, to] of HOURS) {
    if (h >= from && h < to) return name;
  }
  return '夜间';
}

function countBy(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function timeline(records) {
  const years = [...countBy(records, (r) => (r.taken ? String(r.taken.getFullYear()) : '')).entries()]
    .map(([key, count]) => ({ key, name: key + ' 年', count }))
    .sort((a, b) => b.key.localeCompare(a.key));
  const months = [...countBy(records, (r) => (r.taken ? String(r.taken.getMonth() + 1) : '')).entries()]
    .map(([key, count]) => ({ key, name: `${key} 月`, count, month: Number(key) }))
    .sort((a, b) => a.month - b.month);
  const hours = [...countBy(records, (r) => (r.taken ? hourBand(r.taken.getHours()) : '')).entries()]
    .map(([key, count]) => ({ key, name: key, count }));
  // 时段固定按时间顺序输出，缺的补 0，前端画柱状图不会忽大忽小
  const hourOrder = HOURS.map(([n]) => n);
  hours.sort((a, b) => hourOrder.indexOf(a.key) - hourOrder.indexOf(b.key));
  const peak = hours.slice().sort((a, b) => b.count - a.count)[0] || null;

  // 拍摄天数与跨度：仪表盘顶部要「拍了多少天 / 最早到最晚」
  const daySet = new Set();
  let first = null;
  let last = null;
  for (const r of records) {
    if (!r.taken) continue;
    daySet.add(`${r.taken.getFullYear()}-${r.taken.getMonth() + 1}-${r.taken.getDate()}`);
    if (!first || r.taken < first) first = r.taken;
    if (!last || r.taken > last) last = r.taken;
  }
  return { years, months, hours, peak, dayCount: daySet.size, first, last };
}

/* ---------------- 发现趋势：按月「照片数 / 物种新增 / 物种累计」 ----------------
 * 物种累计按「该物种首次出现」算：先给每个物种找最早的月份，再顺着月份累加。
 */

function trendByMonth(records) {
  const map = new Map(); // '2026-05' → {photos, species:Set}
  const firstSeen = new Map(); // speciesKey → 'YYYY-MM'
  for (const r of records) {
    if (!r.taken) continue;
    const key = `${r.taken.getFullYear()}-${String(r.taken.getMonth() + 1).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, { photos: 0, species: new Set() });
    const cell = map.get(key);
    cell.photos += 1;
    if (r.labeled && r.taxon) {
      const sp = speciesKey(r.taxon);
      cell.species.add(sp);
      const prev = firstSeen.get(sp);
      if (!prev || key < prev) firstSeen.set(sp, key);
    }
  }
  const keys = [...map.keys()].sort();
  const bornMap = new Map(); // 月份 → 新增物种数
  for (const [, k] of firstSeen) bornMap.set(k, (bornMap.get(k) || 0) + 1);
  let cum = 0;
  return keys.map((k) => {
    const born = bornMap.get(k) || 0;
    cum += born;
    return { key: k, photos: map.get(k).photos, species: map.get(k).species.size, born, cum };
  });
}

/* ---------------- 活跃热力图：每天拍了多少张 ---------------- */

function heatmap(records, days) {
  const span = days || 365;
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - (span - 1) * 86400000);
  const m = new Map();
  let max = 0;
  let maxSp = 0;
  for (const r of records) {
    if (!r.taken) continue;
    const d = new Date(r.taken.getFullYear(), r.taken.getMonth(), r.taken.getDate());
    if (d < start || d > end) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let cell = m.get(key);
    if (!cell) {
      cell = { n: 0, sp: new Set() };
      m.set(key, cell);
    }
    cell.n += 1;
    if (r.labeled && r.taxon) cell.sp.add(speciesKey(r.taxon));
    if (cell.n > max) max = cell.n;
    if (cell.sp.size > maxSp) maxSp = cell.sp.size;
  }
  return {
    start: start.getTime(),
    end: end.getTime(),
    span,
    max,
    maxSp,
    days: [...m.entries()].map(([d, v]) => ({ d, n: v.n, sp: v.sp.size })),
  };
}

/* ---------------- 最近拍摄（缩略图条） ---------------- */

function recent(records, n) {
  const pad = (v) => String(v).padStart(2, '0');
  return records
    .filter((r) => r.taken)
    .sort((a, b) => b.taken - a.taken)
    .slice(0, n || 12)
    .map((r) => ({
      path: r.path || '',
      stem: r.stem || '',
      // 用本地时间字符串，别给 ISO：ISO 是 UTC，东八区会显示成前一天
      taken: `${r.taken.getFullYear()}-${pad(r.taken.getMonth() + 1)}-${pad(r.taken.getDate())} ${pad(r.taken.getHours())}:${pad(r.taken.getMinutes())}:${pad(r.taken.getSeconds())}`,
      cn: (r.taxon && r.taxon.cn) || '',
    }));
}

/* ---------------- 器材：机身覆盖 ----------------
 * 只认 EXIF 的 Make/Model（手机也会写，所以手机也能统计出来）。
 * 覆盖率 = 有器材信息的张数 / 总张数，用来提示「结果可能不全」。
 */

function gear(records) {
  const m = new Map();
  let covered = 0;
  for (const r of records) {
    const body = String(r.body || '').trim();
    if (!body) continue;
    covered += 1;
    m.set(body, (m.get(body) || 0) + 1);
  }
  return {
    bodies: [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    covered,
    total: records.length,
    rate: records.length ? covered / records.length : 0,
  };
}

/* ---------------- 排行榜：带拉丁名，支持按数量 / 按学名 ----------------
 * 现有的 byDimension 把中文名和拉丁名拼成一个显示字符串，
 * 排行榜要「按学名排序」就得把原始学名单独留着。
 */

function rankTable(records, rank) {
  const labeled = records.filter((r) => r.labeled && r.taxon && r.taxon.resolved);
  const m = new Map();
  for (const r of labeled) {
    const latin = r.taxon[rank];
    if (!latin) continue;
    const cn = r.taxon[rank + 'Cn'] || '';
    const cell = m.get(latin) || { latin, cn, count: 0 };
    if (!cell.cn && cn) cell.cn = cn;
    cell.count += 1;
    m.set(latin, cell);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.latin.localeCompare(b.latin));
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
  coverage,
  timeline,
  trendByMonth,
  heatmap,
  recent,
  gear,
  rankTable,
  HOURS,
  hourBand,
};
