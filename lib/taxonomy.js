'use strict';
/**
 * 学名 → 界/门/纲/目/科/属 的中文阶元（只到属，种归进属文件夹）。
 *
 * 为什么需要它：图片元数据里只有「中文名 + 学名」，没有分类层级。
 * 要按「界门纲目科属」建目录，就必须拿学名去查一次分类系统。
 *
 * 取数顺序（按用户要求）：
 *   ⓪ 本地名录    —— lib/local-taxo.js 读 Chinese-Latin 的 backbone（离线、最快），优先；
 *   ① iNaturalist —— 本地没有时用，能给中文阶元名（动物界/节肢动物门/昆虫纲/鳞翅目/凤蝶科/虎凤蝶属）；
 *   ② GBIF        —— 都查不到时兜底，只有拉丁学名（Animalia/Arthropoda/Insecta…）。
 *
 * 网络策略：
 *   - iNat 先按学名搜索拿到 id 与 ancestry（一次），再把**所有物种**的祖先 id 合并成
 *     几次批量请求取名字（`/v1/taxa/1,2,3` 一次能拿一串），所以 50 个物种大约只要
 *     50 + 2 次请求，而不是 100 次；
 *   - 请求间隔 ≥200ms、并发 2，避免撞 iNat 的 60 次/分钟限流；
 *   - 结果按学名落盘缓存（data/cache/taxonomy/taxonomy.json），查过一次就再不上网；
 *     查不到的记 7 天，过期内不重复试（多半是本来就没有，不是网络问题）。
 *
 * 零依赖：只用 Node 22 自带的 fetch。
 */

const fs = require('node:fs');
const path = require('node:path');
// 本地物种名录（Chinese-Latin 的 backbone 数据库）：能本地解析就绝不上网
const LOCAL = require('./local-taxo');

/** 需要的阶元，从高到低。种不建目录 —— 同属的物种放进同一个属文件夹。 */
const RANKS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];

const INAT = 'https://api.inaturalist.org/v1';
const GBIF = 'https://api.gbif.org/v1';
const UA = 'tagden/1.0 (local desktop tool)';

const MISS_TTL = 7 * 24 * 3600 * 1000; // 查不到：7 天后重试
// GBIF 的记录 30 天后重查一次：那次掉到 GBIF 可能只是 iNat 临时抽风/被限流，
// 重查一次就能补上中文名。iNat 查到的则长期有效（分类名基本不变）。
const GBIF_TTL = 30 * 24 * 3600 * 1000;
const MIN_GAP = 200; // iNat 请求最小间隔（ms）
const CONCURRENCY = 2;

let cacheDir = '';
let cacheFile = '';
let store = {}; // 小写学名 -> { at, src, ranks?, miss? }
let dirty = false;
let saveTimer = null;
let lastCall = 0;

/**
 * 阶元拉丁名 → 中文名（进程内记忆），键是 `${rank}:${latin 小写}`。
 *
 * 为什么要有它：GBIF 兜底只给拉丁名；回查 iNat 中文名时若被限流/超时，
 * 补了一半就落盘 `cnTried:true`，30 天内不再重试。于是同一目会拼出
 * 「Lepidoptera」和「鳞翅目 Lepidoptera」两种文件夹。
 * 现在从已有缓存里把「谁已经知道中文名」抽成一张表，缺的先用它离线补齐，
 * 再考虑联网 —— 同一阶元无论走哪个数据源，目录名都一致。
 */
const RANK_CN = new Map();

function memoKey(rank, latin) {
  return `${rank}:${String(latin || '').toLowerCase()}`;
}

function rememberRankCn(rank, latin, cn) {
  const c = String(cn || '').trim();
  if (c) RANK_CN.set(memoKey(rank, latin), c);
}

/** 从整个缓存重建记忆表：既看物种记录的 ranks，也看 rank: 前缀的阶元缓存 */
function rebuildMemo() {
  RANK_CN.clear();
  for (const k of Object.keys(store)) {
    const rec = store[k];
    if (!rec) continue;
    if (rec.ranks) {
      for (const r of RANKS) {
        const v = rec.ranks[r];
        if (v && v.latin && v.cn) rememberRankCn(r, v.latin, v.cn);
      }
    } else if (k.startsWith('rank:') && rec.cn) {
      // 键形如 rank:<rank>:<latin>
      RANK_CN.set(k.slice(5), String(rec.cn).trim());
    }
  }
}

/** 用记忆表补全缺失的阶元中文名（就地改，不联网） */
function fillFromMemo(ranks) {
  if (!ranks) return ranks;
  for (const r of RANKS) {
    const v = ranks[r];
    if (v && v.latin && !String(v.cn || '').trim()) {
      const c = RANK_CN.get(memoKey(r, v.latin));
      if (c) v.cn = c;
    }
  }
  return ranks;
}

/* ---------------- 缓存 ---------------- */

function init(dir) {
  cacheDir = dir;
  cacheFile = path.join(dir, 'taxonomy.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j && j.v === 1 && j.items && typeof j.items === 'object') store = j.items;
  } catch {}
  rebuildMemo();
}

function touch() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  if (!dirty || !cacheFile) return;
  dirty = false;
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, items: store }));
  } catch {}
}

function fresh(rec) {
  if (!rec) return false;
  if (rec.miss) return Date.now() - rec.at < MISS_TTL;
  if (rec.src === 'gbif') {
    // 老版本 GBIF 记录只有拉丁名（会建出「Animalia」这种没有中文的文件夹）。
    // 没有 cnTried 标记的当成过期，重查一次把中文阶元名补上；补过之后照常缓存 30 天。
    if (!rec.cnTried) return false;
    return Date.now() - rec.at < GBIF_TTL;
  }
  return true; // iNat 查到的分类基本不会变，长期有效
}

/* ---------------- 网络小工具 ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 全局节流：保证相邻两次请求发起至少隔 MIN_GAP 毫秒 */
async function gate() {
  const now = Date.now();
  const wait = lastCall + MIN_GAP - now;
  lastCall = Math.max(now, lastCall + MIN_GAP);
  if (wait > 0) await sleep(wait);
}

async function getJson(url, timeout = 12000) {
  await gate();
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * 带退避重试的取 JSON。
 * iNat 对突发请求会返回 429，一次合并请求被打回就会让**整批**物种掉到 GBIF，
 * 中文名全没了 —— 所以 429/5xx/超时都要再试两次。
 */
async function getJsonRetry(url, timeout = 12000, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await getJson(url, timeout);
    } catch (err) {
      lastErr = err;
      const retriable = !err.status || err.status === 429 || err.status >= 500;
      if (!retriable || i === tries - 1) break;
      await sleep(800 * (i + 1) + Math.floor(Math.random() * 300));
    }
  }
  throw lastErr;
}

/** 并发限流 map */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = new Array(Math.min(limit, list.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- iNaturalist ---------------- */

/**
 * 一次搜索：拿 id / ancestry / 自身中文名。
 *
 * byName=true 时表示 q 是**中文名**（没有学名可用）。iNat 的中文搜索是字符级的模糊匹配，
 * 「东方蜉蝣」能给你返回「西方蜜蜂」——所以这里只认 `preferred_common_name` 与查询**完全相等**
 * 的那条，宁可不认，也绝不把物种挂到错的门纲目科属下面。
 */
async function inatSearch(q, byName) {
  const perPage = byName ? 30 : 5;
  const url = `${INAT}/taxa?q=${encodeURIComponent(q)}&locale=zh-CN&per_page=${perPage}&order_by=observations_count`;
  const j = await getJsonRetry(url);
  const list = (j && j.results) || [];
  if (!list.length) return null;
  let hit;
  if (byName) {
    const want = String(q).trim();
    const same = list.filter((t) => String(t.preferred_common_name || '').trim() === want);
    if (!same.length) return null;
    hit = same.find((t) => t.rank === 'species') || same[0];
  } else {
    const low = String(q).toLowerCase().trim();
    const firstWord = low.split(/\s+/)[0];
    // 学名完全一致最好；否则只认「属名对得上」的那条。
    // 不做这一步的话，一个拼错的学名会被 iNat 的相关度排序带去别的类群，
    // 照片就被默默地放进了错误的科属里 —— 那比「未分类」糟得多。
    hit =
      list.find((t) => String(t.name || '').toLowerCase() === low) ||
      list.find((t) => String(t.name || '').toLowerCase().startsWith(`${firstWord} `)) ||
      null;
    if (!hit) return null;
  }
  return {
    id: hit.id,
    name: hit.name || q,
    rank: hit.rank || '',
    cn: hit.preferred_common_name || '',
    ancestry: String(hit.ancestry || ''),
  };
}

/** 批量取分类元：ids 一次最多给 ~130 个，URL 不至于超长；整批失败再拆小块重试 */
async function inatTaxaByIds(ids) {
  const map = new Map();
  async function fetchChunk(chunk, depth) {
    try {
      const j = await getJsonRetry(`${INAT}/taxa/${chunk.join(',')}?locale=zh-CN`, 12000, depth ? 2 : 3);
      for (const t of (j && j.results) || []) map.set(t.id, t);
    } catch {
      // 还不行就拆小块（有些代理对长 URL 不友好）
      if (!depth && chunk.length > 20) {
        for (let i = 0; i < chunk.length; i += 20) await fetchChunk(chunk.slice(i, i + 20), 1);
      }
    }
  }
  for (let i = 0; i < ids.length; i += 130) await fetchChunk(ids.slice(i, i + 130), 0);
  return map;
}

/** 从 ancestry 串 + 自身，拼出六个阶元 */
function buildRanks(ancestry, self, byId) {
  const ids = ancestry ? ancestry.split('/').map((x) => Number(x)).filter(Boolean) : [];
  if (self && self.id && !ids.includes(self.id)) ids.push(self.id);
  const ranks = {};
  for (const id of ids) {
    const t = byId.get(id);
    if (!t || !RANKS.includes(t.rank)) continue;
    ranks[t.rank] = {
      latin: t.name || '',
      cn: t.preferred_common_name || '',
    };
  }
  // 自身就是属/科等阶元时（用户只给了属名），byId 里可能没有它
  if (self && RANKS.includes(self.rank) && !ranks[self.rank]) {
    ranks[self.rank] = { latin: self.name || '', cn: self.cn || '' };
  }
  return ranks;
}

/* ---------------- GBIF 兜底 ---------------- */

async function gbifMatch(latin) {
  const j = await getJsonRetry(`${GBIF}/species/match?name=${encodeURIComponent(latin)}`, 12000, 2);
  if (!j || j.matchType === 'NONE' || !j.kingdom) return null;
  const ranks = {};
  for (const r of RANKS) {
    const v = r === 'class' ? j['class'] : j[r];
    if (v) ranks[r] = { latin: String(v), cn: '' };
  }
  return Object.keys(ranks).length ? { src: 'gbif', ranks } : null;
}

/**
 * 单个阶元名 → 中文名（Animalia → 动物界）。
 *
 * GBIF 只给拉丁名，直接拿它建目录就会出现「Animalia」和「动物界 Animalia」两个文件夹 ——
 * 所以兜底之后拿每个阶元的拉丁名回 iNat 查一次中文名。要求**学名完全相等且阶元一致**，
 * 不做模糊匹配（同 inatSearch 的理由：宁可没有中文，也不能挂错类群）。
 * 高阶元（界门纲目科属）在 iNat 上基本都有中文名，且同一个科被几十个物种共用，
 * 缓存按「阶元+学名」去重后，实际请求数远小于物种数。
 */
async function inatRankCn(latin, rank) {
  const name = String(latin || '').trim();
  if (!name) return '';
  const key = `rank:${rank}:${name.toLowerCase()}`;
  // 记忆表里已经有（别的物种解析过同一阶元）→ 直接离线返回，省一次请求
  const memo = RANK_CN.get(key);
  if (memo) return memo;
  const cached = store[key];
  if (cached) {
    if (cached.miss) return '';
    if (cached.cn) {
      rememberRankCn(rank, name, cached.cn);
      return cached.cn;
    }
    return '';
  }
  try {
    const j = await getJsonRetry(
      `${INAT}/taxa?q=${encodeURIComponent(name)}&rank=${rank}&locale=zh-CN&per_page=10`,
      12000,
      2
    );
    const low = name.toLowerCase();
    const hit = ((j && j.results) || []).find(
      (t) => String(t.name || '').toLowerCase() === low && String(t.rank || '') === rank
    );
    const cn = hit ? String(hit.preferred_common_name || '').trim() : '';
    store[key] = cn ? { at: Date.now(), src: 'rankcn', cn } : { at: Date.now(), miss: true };
    if (cn) rememberRankCn(rank, name, cn);
    touch();
    return cn;
  } catch {
    return '';
  }
}

/** 给 GBIF 那条记录补齐中文阶元名（查不到的留空，不会变成空括号） */
async function fillRankCn(ranks) {
  const items = RANKS.filter((r) => ranks[r] && ranks[r].latin && !ranks[r].cn);
  await mapLimit(items, CONCURRENCY, async (r) => {
    const cn = await inatRankCn(ranks[r].latin, r);
    if (cn) ranks[r].cn = cn;
  });
  return ranks;
}

/* ---------------- 对外接口 ---------------- */

/**
 * 批量解析。list = [{ latin, cn }]，返回 Map<key, record>，key 是学名（小写）；
 * 只有中文名、没有学名的，key 是 'cn:中文名'。
 * record = { ok:true, src:'inat'|'gbif', ranks:{kingdom:{latin,cn},…} }
 *        | { ok:false, src:'', ranks:{} }
 *
 * 永不抛错：网络断了也只是 ok:false，调用方据此把图丢进「未分类」。
 */
async function resolve(list) {
  const want = [];
  const seen = new Set();
  for (const it of list || []) {
    const latin = String((it && it.latin) || '').trim();
    const cn = String((it && it.cn) || '').trim();
    // 只有中文名也能试 —— iNat 的搜索认中文（中华虎凤蝶 → Luehdorfia chinensis）
    const q = latin || cn;
    if (!q) continue;
    const key = latin ? latin.toLowerCase() : `cn:${cn.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    want.push({ key, q, latin });
  }

  const out = new Map();
  const todo = [];
  for (const w of want) {
    const rec = store[w.key];
    if (fresh(rec)) {
      // 旧缓存里可能有「cnTried 但某个阶元中文名没补上」的记录；
      // 返回前用记忆表就地补全，避免同一目又建出一个纯拉丁文件夹。
      out.set(
        w.key,
        rec.miss ? { ok: false, src: '', ranks: {} } : { ok: true, src: rec.src, ranks: fillFromMemo(rec.ranks) }
      );
    } else {
      todo.push(w);
    }
  }
  if (!todo.length) return out;

  /*
   * ⓪ 本地名录优先：Chinese-Latin 的 backbone 里有 774 万行、每行自带
   *   界门纲目科属与中文名，查一次是微秒级索引命中。命中就不再联网 ——
   *   归档 / 统计上万张图时，这一步能省掉几分钟的 iNat 排队。
   *   只有本地查不到（冷门类群、名录没收录）才继续走下面的 iNat → GBIF。
   */
  const pending = [];
  for (const w of todo) {
    let ranks = null;
    try {
      ranks = LOCAL.resolve(w.latin, w.latin ? '' : w.cn);
    } catch {
      ranks = null;
    }
    if (ranks && (ranks.genus || ranks.family)) {
      store[w.key] = { at: Date.now(), src: 'local', ranks };
      out.set(w.key, { ok: true, src: 'local', ranks });
      touch();
    } else {
      pending.push(w);
    }
  }
  if (!pending.length) {
    flush();
    return out;
  }

  /* ① iNat：先搜索（并发 2），再批量取祖先名 */
  const hits = await mapLimit(pending, CONCURRENCY, async (w) => {
    try {
      return { w, hit: await inatSearch(w.q, !w.latin) };
    } catch {
      return { w, hit: null, error: true };
    }
  });

  const idSet = new Set();
  for (const h of hits) {
    if (!h.hit) continue;
    if (h.hit.ancestry) for (const x of h.hit.ancestry.split('/')) if (x) idSet.add(Number(x));
    idSet.add(h.hit.id);
  }
  const byId = idSet.size ? await inatTaxaByIds([...idSet]) : new Map();

  const stillMiss = [];
  for (const h of hits) {
    const { w, hit } = h;
    if (hit) {
      const ranks = buildRanks(hit.ancestry, hit, byId);
      // 至少要能定位到「属」，否则对分层归档没用，转去 GBIF 试试
      if (ranks.genus || ranks.family) {
        store[w.key] = { at: Date.now(), src: 'inat', ranks };
        out.set(w.key, { ok: true, src: 'inat', ranks });
        touch();
        continue;
      }
    }
    stillMiss.push(w);
  }

  /* ② GBIF 兜底（只认学名，中文名去查没意义） */
  if (stillMiss.length) {
    await mapLimit(stillMiss, CONCURRENCY, async (w) => {
      let rec = null;
      if (/^[A-Za-z]/.test(w.q)) {
        try {
          rec = await gbifMatch(w.q);
        } catch {
          rec = null;
        }
      }
      if (rec) {
        // 兜底记录只有拉丁名，先用记忆表离线补，再回查 iNat，让文件夹统一成「中文 拉丁」
        fillFromMemo(rec.ranks);
        await fillRankCn(rec.ranks);
        fillFromMemo(rec.ranks);
        store[w.key] = { at: Date.now(), src: rec.src, ranks: rec.ranks, cnTried: true };
        out.set(w.key, { ok: true, src: rec.src, ranks: rec.ranks });
      } else {
        store[w.key] = { at: Date.now(), miss: true };
        out.set(w.key, { ok: false, src: '', ranks: {} });
      }
      touch();
    });
  }

  flush();
  return out;
}

/**
 * 目录层级，**以拉丁阶元名为准**，文件夹名写成「中文 拉丁」：
 *   ['动物界 Animalia','节肢动物门 Arthropoda','昆虫纲 Insecta','鳞翅目 Lepidoptera',
 *    '凤蝶科 Papilionidae','虎凤蝶属 Luehdorfia']
 * 没有中文名（比如 GBIF 兜底）就只留拉丁学名，不会出现空括号或「未命名」。
 */
function segName(v) {
  const latin = String((v && v.latin) || '').trim();
  const cn = String((v && v.cn) || '').trim();
  if (cn && latin && cn !== latin) return `${cn} ${latin}`;
  return latin || cn;
}

function pathSegments(rec) {
  if (!rec || !rec.ok) return [];
  // 兜底：调用方可能拿到的是未经 resolve 补全的 ranks，这里再补一次，保证目录名一致
  fillFromMemo(rec.ranks);
  const segs = [];
  for (const r of RANKS) {
    const v = rec.ranks && rec.ranks[r];
    if (!v) continue;
    const name = segName(v);
    if (name) segs.push(name);
  }
  return segs;
}

/** 方便别处判断：这条记录有没有可用到属的层级 */
function hasLineage(rec) {
  return !!(rec && rec.ok && rec.ranks && (rec.ranks.genus || rec.ranks.family));
}

module.exports = { init, resolve, pathSegments, hasLineage, RANKS, flush };
