'use strict';

/**
 * 自然在线（ecp.ibiodiversity.cn）subsite 层：按地区查「这个属在本地有哪些种」。
 *
 * 为什么挂在自然在线下面
 * ------------------
 * 「看图识别」和「各保护区自建的物种名录」是同一套后端（同一个域名、同一张令牌）：
 * 前者走 identify/xingse，后者是这里的 subsite 层。名录正好补上 PPBC 缺的那块：
 * PPBC 是全国照片墙，这里是**某个保护区自己编的名录**，两者的出入本身就是线索。
 * 站方没有公开接口，抓的是私有的 /api/online/…；本站点现在默认对所有用户开放
 * （以前要输暗号解锁，已取消），所以只要用户选了植物类群就能用。
 *
 * 三个接口（都是私有接口，全部要 Bearer 令牌）
 * -------------------------------------------
 *   搜站点  POST /api/online/site/channel/public/page  { pageNum, pageSize, title }
 *           → data.list[]，每项 { id, title, webMaster, updateTime }。站名是中文标题，
 *             id 是拼音串（wuyishan / minjiangyuan），**不能拿标题当地址**。
 *   取名录  GET  /api/online/site/species/list/all/{siteId}
 *           → data[]，每项 { lname, cname, genusName, cgenusName, cfamilyName,
 *             levelName, kingdom, photoCount, nameAuthor, … }
 *           **必须 GET**：同样的路径用 POST 会返回 B0001（参数格式错误），别改成 POST。
 *   看页面  https://ecp.ibiodiversity.cn/subsite/photoTree/{siteId}
 *
 * 名录不能按属过滤，也不能分页
 * ----------------------------
 * 实测给 list/all 加上 genusName / genus / lname / pageNum / pageSize 全都无效，
 * 永远返回整份名录（武夷山植物图库 2210 条 ≈ 1.2 MB）。所以只能整份拉下来自己按属挑，
 * 还好站方这个接口本身不慢。为了避免每次点都重拉，这里按站点缓存 30 分钟（LRU 24 个站）。
 *
 * 站点 ≠ 行政区
 * -------------
 * 搜「武夷」命中 4 个站（武夷山植物图库、黄龙岩保护区、武夷山国家公园、植物标识系统），
 * 搜「闽江源」命中 2 个（闽江源国家级自然保护区、福建闽江源国家级自然保护区）。
 * 所以这里是「给你一串站，让你按站点看」，不是「按行政区汇总」，面板里要如实说明。
 *
 * 已知的搜索毛病
 * --------------
 * 站名是文本模糊匹配：搜「南平」会命中「湖南平江芦头林场」。所以关键词尽量用地名本身
 * （「武夷山」而不是「南平市武夷山市」），命中的站也要人眼看一眼是不是本地的。
 */

const { requestJson, SiteError } = require('./http');

const HOST = 'https://ecp.ibiodiversity.cn';

/** 站点缓存 30 分钟：名录是编辑出来的，不会分钟级变动 */
const CATALOG_TTL = 30 * 60 * 1000;
/** 站点搜索结果缓存 10 分钟 */
const SEARCH_TTL = 10 * 60 * 1000;
/** 最多同时拉几份名录（一份 1 MB 上下，太快会被站方限流） */
const CONCURRENCY = 4;
/** 一次最多扫几个站（再多点开面板要等太久） */
const MAX_SITES = 12;
/** 单个站点最多列几个种（面板里只做速览，全量去站内看） */
const MAX_SPECIES = 30;
/** 缓存里最多留几个站的名录 */
const CATALOG_MAX = 24;

const catalogCache = new Map(); // siteId → { at, data }
const searchCache = new Map(); // keyword → { at, list }

/* ---------------- 底层请求 ---------------- */

async function api(token, pathname, { method = 'GET', body } = {}) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    origin: HOST,
    referer: HOST + '/subsite',
  };
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json;charset=UTF-8';
    payload = JSON.stringify(body);
  }
  const { res, json } = await requestJson(HOST + pathname, {
    method,
    headers,
    body: payload,
    timeout: 30000,
  });
  if (!json) {
    throw new SiteError(`自然在线接口未返回 JSON（HTTP ${res.status}）`, { status: res.status });
  }
  if (json.code !== '00000') {
    const msg = String(json.msg || '');
    // 令牌过期时站方给的是登录失效一类的提示，这里翻译成人话，方便面板直接显示
    if (/登录|token|未授权|授权/i.test(msg) || res.status === 401) {
      throw new SiteError('自然在线登录已过期，请在「账号设置」里重新取一次验证码登录', { status: 401 });
    }
    throw new SiteError(msg || '自然在线接口报错', { status: res.status });
  }
  return json;
}

/** 站点搜索（一次 30 个够用；标题模糊匹配，可能混入同名站） */
async function searchSites(token, keyword, size = 30) {
  const j = await api(token, '/api/online/site/channel/public/page', {
    method: 'POST',
    body: { pageNum: 1, pageSize: size, title: keyword },
  });
  const list = Array.isArray(j.data?.list) ? j.data.list : [];
  return list
    .map((s) => ({
      id: String(s.id || ''),
      title: String(s.title || '').trim(),
      master: String(s.webMaster || '').trim(),
      updated: String(s.updateTime || '').slice(0, 10),
    }))
    .filter((s) => s.id && s.title);
}

/**
 * 拉一份站点名录，压成「按属分组」的精简结构。
 * 原始名录一条 23 个字段，整份 1 MB 上下；这里只留面板要用的 6 个，按属分组后
 * 同一个属再查就是 O(1)。
 */
async function catalog(token, siteId) {
  const hit = catalogCache.get(siteId);
  if (hit && Date.now() - hit.at < CATALOG_TTL) {
    // LRU：命中后挪到队尾
    catalogCache.delete(siteId);
    catalogCache.set(siteId, hit);
    return hit.data;
  }

  const j = await api(token, `/api/online/site/species/list/all/${encodeURIComponent(siteId)}`);
  const rows = Array.isArray(j.data) ? j.data : [];
  const byGenus = new Map();
  const genera = new Set();
  for (const r of rows) {
    const g = String(r.genusName || '').trim();
    if (!g) continue;
    genera.add(g);
    const lv = String(r.levelName || '').trim();
    // 「仅鉴定到属」的那条（levelName=Genus）不算种，但它证明这个属在名录里出现过
    const item = {
      latin: String(r.lname || '').trim(),
      cn: String(r.cname || '').trim(),
      family: String(r.cfamilyName || '').trim(),
      level: lv,
      photos: Number(r.photoCount) || 0,
      author: String(r.nameAuthor || '').trim(),
    };
    if (!byGenus.has(g)) byGenus.set(g, []);
    byGenus.get(g).push(item);
  }
  const data = {
    total: rows.length,
    genera: genera.size,
    byGenus,
    at: Date.now(),
  };

  catalogCache.set(siteId, { at: Date.now(), data });
  while (catalogCache.size > CATALOG_MAX) {
    catalogCache.delete(catalogCache.keys().next().value);
  }
  return data;
}

/** 名录里某个属的种（去掉「仅鉴定到属」那条，按有无照片、学名排） */
function speciesOf(cat, genus) {
  const arr = cat.byGenus.get(genus) || [];
  const isGenusLevel = (it) => /^genus$/i.test(it.level) || (!it.cn && it.latin === genus);
  const species = arr.filter((it) => !isGenusLevel(it));
  species.sort((a, b) => b.photos - a.photos || a.latin.localeCompare(b.latin));
  return { species, hasGenusNode: arr.length > species.length };
}

/* ---------------- 关键词 ---------------- */

/** 去掉英文尾巴（iNat 的中文地名常粘着英文） */
function stripEnglish(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.replace(/^([\u4e00-\u9fa5][\u4e00-\u9fa5（）()·\s]*?)([A-Za-z].*)$/, '$1').trim();
}

/**
 * 检索地区名 → 站点搜索关键词。
 *
 *   南平市武夷山市Wuyishan City → 武夷山   （取最细一级，再去行政区后缀）
 *   武夷山国家级自然保护区      → 武夷山
 *   福建省                     → 福建
 *   香港特别行政区              → 香港
 *
 * 站名是「武夷山植物图库」这种，带「市 / 县 / 省」去搜反而不命中，所以后缀一律去掉。
 */
/** 「全世界 / 全球」这类泛称不是地名，拿去搜站点只会白跑一趟 */
const GENERIC_NAMES = new Set(['全世界', '全球', '世界', '不限', 'anywhere', 'world']);

function keywordOf(placeName) {
  let s = stripEnglish(placeName);
  if (!s || !/[\u4e00-\u9fa5]/.test(s)) return '';
  if (/^(全世界|全球|世界|不限)/.test(s) || /不限地区/.test(s) || GENERIC_NAMES.has(s.toLowerCase())) return '';
  // 只留最细一级行政区
  const parts = s.match(/[^市县区旗盟州]*[市县区旗盟州]/g);
  if (parts && parts.length > 1) s = parts[parts.length - 1];
  // 去掉保护区一类的尾巴
  s = s.replace(
    /(国家级|省级|市级)?(自然保护区|保护区|国家公园|森林公园|湿地公园|地质公园|沙漠公园|风景区|景区|公园|植物园|水库|林场)$/,
    '',
  );
  // 「西双版纳傣族自治州」「海西蒙古族藏族自治州」先去掉民族名，否则会剩下「西双版纳傣族」
  s = s.replace(/([\u4e00-\u9fa5]{1,5}族)+(自治州|自治县|自治旗)/, '$2');
  // 再统一去掉行政区后缀
  s = s
    .replace(/(特别行政区|自治区|自治州|自治县|自治旗|省|市|县|区|旗|盟|州)$/, '')
    .trim();
  return s;
}

/* ---------------- 并发 ---------------- */

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- 主入口 ---------------- */

/**
 * 查「某个属」在若干站点名录里各有多少种。
 *
 * @param {string} token    自然在线的 Bearer 令牌（没登录就没有，直接报错）
 * @param {object} opt      { genus, keyword, limit }
 * @returns {{genus, keyword, matched, scanned, sites, skipped}}
 */
async function genusBySites(token, opt = {}) {
  const genus = String(opt.genus || '').trim();
  if (!genus) throw new SiteError('没有属名');
  if (!token) throw new SiteError('自然在线还没登录：先在「账号设置」里取一次验证码登录', { status: 401 });

  const keyword = String(opt.keyword || '').trim();
  if (!keyword) throw new SiteError('请先填一个站点关键词（比如 武夷山、闽江源）');

  let list;
  const hit = searchCache.get(keyword);
  if (hit && Date.now() - hit.at < SEARCH_TTL) {
    list = hit.list;
  } else {
    list = await searchSites(token, keyword);
    searchCache.set(keyword, { at: Date.now(), list });
    while (searchCache.size > 32) searchCache.delete(searchCache.keys().next().value);
  }

  const limit = Math.max(1, Math.min(MAX_SITES, Number(opt.limit) || MAX_SITES));
  const picked = list.slice(0, limit);

  const rows = await mapLimit(picked, CONCURRENCY, async (s) => {
    try {
      const cat = await catalog(token, s.id);
      const { species } = speciesOf(cat, genus);
      return { ...s, total: cat.total, genera: cat.genera, n: species.length, species };
    } catch (err) {
      return { ...s, total: 0, genera: 0, n: 0, species: [], error: err.message || '名录拉取失败' };
    }
  });

  // 有该属的站排前面：先按种数，再按名录规模（名录大的站更可信）
  rows.sort((a, b) => b.n - a.n || b.total - a.total);

  return {
    genus,
    keyword,
    matched: list.length,
    scanned: picked.length,
    skipped: Math.max(0, list.length - picked.length),
    sites: rows.map((r) => ({
      id: r.id,
      title: r.title,
      master: r.master,
      updated: r.updated,
      total: r.total,
      genera: r.genera,
      n: r.n,
      more: Math.max(0, r.species.length - MAX_SPECIES),
      species: r.species.slice(0, MAX_SPECIES),
      error: r.error || '',
      url: pageUrl(r.id),
    })),
  };
}

/** 站点页面（只吃站点 id，深链不到某个属） */
function pageUrl(siteId) {
  return `${HOST}/subsite/photoTree/${encodeURIComponent(String(siteId || ''))}`;
}

module.exports = {
  HOST,
  CATALOG_TTL,
  MAX_SITES,
  keywordOf,
  pageUrl,
  searchSites,
  catalog,
  genusBySites,
};
