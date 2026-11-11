'use strict';
/**
 * 物种中文名 → 大陆规范名（《中国生物物种名录》CoL China / 物种2000中国节点）。
 *
 * 为什么要有它：合并识别结果里的中文名来自各识别站点 —— 百度给中文、iNaturalist 给
 * preferred_common_name（可能是台湾名或英文名），不保证是大陆规范名。用户要求
 * 「合并展示里的中文名」和「修改文件名时的中文名」都用大陆名，于是按学名覆盖一次。
 *
 * 数据：**内置**，不联网、不要 API Key、不要 R。
 *   public/colcn.bin 是《中国生物物种名录》年度版分册（sp2000.org.cn/download）抽出的
 *   「学名 → 中文名」紧凑索引，构建工具见 tools/build-colcn.js，随 exe 一起内联。
 *   权威名和俗称会不一样，这正是要它的理由：Papilio bianor 名录里是「碧翠凤蝶」，
 *   不是俗称「碧凤蝶」；Aspidistra fungilliformis 是「伞柱蜘蛛抱蛋」。
 *
 * 覆盖口径（很重要，别随意放宽）：
 *   - 只按**学名**精确 / 二名法匹配；中文名反查不做（名录里 1089 个中文名被多个学名共用，
 *     拿中文名去猜学名会把物种挂到别的类群上，比没有中文名更糟）。
 *   - 名录里本来就没填中文名的行不进索引 —— 没命中就**保留识别站点原名**，不用空串覆盖。
 *   - 没索引 / 索引损坏 / 未命中，一律静默不增强，绝不抛错拖垮识别。
 *
 * 内存：14.8 万条，用「排序数组 + 二分查找」而不是 Map（省一大半内存），
 * 且第一次识别时才加载（懒加载），启动零开销。零依赖：只用 node:zlib 和 lib/assets.js。
 */

const zlib = require('node:zlib');
const ASSETS = require('./assets');

const INDEX_NAME = 'colcn.bin';
const SOURCE = '中国生物物种名录 (Catalogue of Life China, sp2000.org.cn)';

let ready = false;
let version = 0;
let count = 0;
let error = '';
let keys = [];   // 规范化小写学名，已排序
let vals = [];   // 与之对应的大陆中文名

/** 学名规范化：和 lib/aggregate.js 的 normLatin、tools/build-colcn.js 保持同一口径。 */
function normLatin(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // 去掉亚属括号 Papilio (Achillides) bianor
    .replace(/\s+/g, ' ')
    .trim();
}

/** 只取「属 + 种加词」：识别站点常带命名人或亚种，截成二名法再兜一次。 */
function binomial(key) {
  const parts = key.split(' ');
  return parts.length > 2 ? `${parts[0]} ${parts[1]}` : '';
}

/** 二分查找，命中返回中文名，否则返回 ''。 */
function findExact(key) {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keys[mid];
    if (k === key) return vals[mid];
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return '';
}

/** 单个学名查名：先全名（亚种也能命中），再退到属+种。查不到返回 ''。 */
function lookup(latin) {
  if (!ready) return '';
  const key = normLatin(latin);
  if (!key) return '';
  const two = binomial(key);
  return findExact(key) || (two ? findExact(two) : '') || '';
}

/* ---------------- 中文名 → 学名（「物种名核对」反查） ----------------
 * 注意口径：名录里有上千个中文名被多个学名共用，按中文名硬猜学名会把照片
 * 挂到别的类群上，比空着更糟。所以这里**只在唯一命中时**给答案：
 *   · 精确命中一个二名法 → 直接补；
 *   · 命中多个 → 回候选，交给人挑；
 *   · 一个都没有 → 返回空，界面上留给用户手填 / 联网补查。
 * 亚种、异名统一按「属 + 种加词」归并，避免同一物种的几种写法造成假重名。
 */
let rev = null; // Map<规范中文名, Set<二名法学名（小写）>>

function normCn(s) {
  return String(s || '')
    .replace(/[（(][^（()）]*[)）]/g, ' ') // 去掉括号里的别名/附注
    .replace(/\s+/g, ' ')
    .trim();
}

/** 索引里存的是小写学名；补进照片时把属名首字母大写，其余照抄 */
function prettyLatin(s) {
  const k = String(s || '').trim();
  return k ? k.replace(/^[a-z]/, (c) => c.toUpperCase()) : '';
}

function buildReverse() {
  if (!ready) init();
  if (rev) return rev;
  const m = new Map();
  if (ready) {
    for (let i = 0; i < vals.length; i += 1) {
      const cn = normCn(vals[i]);
      if (!cn) continue;
      const two = binomial(keys[i]) || keys[i];
      let set = m.get(cn);
      if (!set) {
        set = new Set();
        m.set(cn, set);
      }
      set.add(two);
    }
  }
  rev = m;
  return m;
}

/** 返回 { latin, ambiguous, candidates }；latin 为空时必须由人来定 */
function lookupLatin(cn) {
  const key = normCn(cn);
  const none = { latin: '', ambiguous: false, candidates: [] };
  if (!key) return none;
  const m = buildReverse();
  const pack = (arr) => {
    const list = [...arr].slice(0, 8).map(prettyLatin);
    if (list.length === 1) return { latin: list[0], ambiguous: false, candidates: list };
    return { latin: '', ambiguous: list.length > 1, candidates: list };
  };
  const exact = m.get(key);
  if (exact) return pack(exact);
  // 宽松匹配只认 3 字以上的名字，且必须唯一；短名字（如「凤蝶」）命中一大串，不猜
  if (key.length >= 3) {
    const loose = new Set();
    for (const [k, set] of m) {
      if (k.length >= 3 && (k.includes(key) || key.includes(k))) {
        for (const la of set) loose.add(la);
      }
      if (loose.size > 8) break;
    }
    if (loose.size) return pack(loose);
  }
  return none;
}

/* ---------------- 中文名近似候选（异名/错字） ----------------
 * 只在精确/宽松匹配都失败、且用户点「自动识别」时才会走到这里。
 * 只认编辑距离 1（一次替换/插入/删除/相邻交换），避免把不同物种猜错；
 * 结果仍交给用户点选，不自动写回。
 */
const suggestCache = new Map();

function editOne(a, b) {
  if (!a || !b || a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    let swapped = false;
    for (let i = 0; i < la; i += 1) {
      if (a[i] === b[i]) continue;
      diff += 1;
      if (diff > 2) return false;
      // 相邻两个字互换也算一次编辑（常见手误）
      if (i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i]) swapped = true;
    }
    return diff === 1 || (diff === 2 && swapped);
  }
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
    } else {
      if (skipped) return false;
      skipped = true;
      j += 1;
    }
  }
  return true;
}

/** 返回 [{cn, latin}] 近似中文名，最多 limit 条；没有就 []。 */
function suggestCn(cn, limit = 6) {
  if (!ready) init();
  const key = normCn(cn);
  if (!ready || key.length < 3) return [];
  const cap = Math.max(1, Math.min(12, Number(limit) || 6));
  const ck = `${key}|${cap}`;
  if (suggestCache.has(ck)) return suggestCache.get(ck);
  const m = buildReverse();
  const out = [];
  const seen = new Set();
  for (const [name, set] of m) {
    if (name.length < 3 || Math.abs(name.length - key.length) > 1) continue;
    if (!editOne(key, name)) continue;
    for (const la of set) {
      const latin = prettyLatin(la);
      const k = `${name}\t${latin}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ cn: name, latin });
    }
  }
  out.sort((a, b) => {
    const da = Math.abs(a.cn.length - key.length);
    const db = Math.abs(b.cn.length - key.length);
    return da - db || a.cn.localeCompare(b.cn, 'zh-CN') || a.latin.localeCompare(b.latin);
  });
  const res = out.slice(0, cap);
  if (suggestCache.size > 200) suggestCache.clear();
  suggestCache.set(ck, res);
  return res;
}

/**
 * 加载内置索引。可重复调用（只真正加载一次）。
 * 源码运行从 public/colcn.bin 读，exe 运行从内联的 base64 资源读（lib/assets.js 统一裁决）。
 */
function init() {
  if (ready) return stat();
  try {
    const got = ASSETS.get(INDEX_NAME);
    if (!got || !got.body) throw new Error('内置索引不存在');
    const text = zlib.gunzipSync(got.body).toString('utf8');
    const lines = text.split('\n');
    if (lines[0] !== 'colcn1') throw new Error('索引格式不符（缺少 colcn1 头）');
    version = Number(lines[1]) || 0;
    const declared = Number(lines[2]) || 0;
    const body = lines.slice(3);
    const k = [];
    const v = [];
    for (let i = 0; i < body.length; i += 1) {
      const line = body[i];
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      k.push(line.slice(0, tab));
      v.push(line.slice(tab + 1));
    }
    keys = k;
    vals = v;
    count = k.length;
    if (!count || (declared && count !== declared)) {
      throw new Error(`索引条目数不符（声明 ${declared}，实际 ${count}）`);
    }
    ready = true;
    error = '';
  } catch (err) {
    ready = false;
    keys = [];
    vals = [];
    count = 0;
    error = err && err.message ? err.message : String(err);
    console.log(`  [i] 大陆中文名录未启用：${error}（不影响识别，沿用站点原名）`);
  }
  return stat();
}

/** 给 apiState / 设置页用的状态。 */
function stat() {
  return {
    ready,
    version,
    count,
    source: SOURCE,
    error: error || '',
  };
}

/**
 * 给合并结果覆盖大陆中文名。rows 是 agg.rows 的原样引用，**就地改 row.cn**。
 * 覆盖后下游「结果页展示 + 写回文件名」自动用上大陆名，无需各改一处。
 * 同步、无网络，返回覆盖了多少行。
 */
function resolve(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  if (!ready) init();
  if (!ready) return 0;
  let applied = 0;
  for (const r of rows) {
    if (!r || !r.latin) continue; // 只有中文名没学名的行不动
    const cn = lookup(r.latin);
    if (cn && cn !== r.cn) {
      r.cn = cn;
      applied += 1;
    }
  }
  return applied;
}

/** 设置页「查一个名字」自检用：不改动任何状态，只回报命中情况。 */
function test(sampleLatin) {
  if (!ready) init();
  const latin = String(sampleLatin || 'Papilio bianor').trim();
  const cn = lookup(latin);
  return {
    ok: Boolean(cn),
    ready,
    latin,
    cn,
    version,
    count,
    error: error || (cn ? '' : '该学名未收录在内置名录里（或名录里本身没有中文名）'),
  };
}

module.exports = { init, stat, lookup, lookupLatin, suggestCn, resolve, test, normLatin, normCn, prettyLatin };
