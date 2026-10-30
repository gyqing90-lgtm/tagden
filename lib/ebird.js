'use strict';

/**
 * eBird（康奈尔鸟类学实验室）——**不是识别站点**，是「地区记录核对」层。
 *
 * 它没有图片识别接口（Merlin 不对外开放），能做的是回答一个观鸟时最实用的问题：
 *   「这个候选物种，在我这个地区最近 14 天有没有人记录过？」
 * 对观鸟社的同学来说，这比单纯的概率更能帮助判断一条候选是否可信 ——
 * 一只在本地从未有记录、且不在分布区/迁徙季的鸟，多半是识别错了。
 *
 * 接口（全部要 header X-eBirdApiToken）：
 *   GET /v2/ref/taxonomy/ebird?fmt=json&species=A,B   学名 → speciesCode（可逗号批量）
 *   GET /v2/data/obs/{region}/recent/{code}?back=14&maxResults=100   该物种近期记录
 *
 * 缓存策略：学名映射变化很慢，存 7 天；记录数存 1 天（同一天反复查同一物种不再打接口）。
 * 缓存落在 data/ebird-cache.json，明文 JSON —— 里面只有物种代码和记录数，没有任何凭据。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./env');
const { SiteError } = require('./http');

const EBIRD_BASE = (process.env.BIOID_EBIRD_BASE || 'https://api.ebird.org/v2').replace(/\/+$/, '');
const CACHE_PATH = path.join(DATA_DIR, 'ebird-cache.json');
const TAX_TTL = 7 * 24 * 3600 * 1000;
const OBS_TTL = 24 * 3600 * 1000;
const BACK_DAYS = 14;
const MAX_LOOKUP = 6;

/* 可选地区：中国各省 + 港澳台 + 常见国家。
   代码是 eBird 的写法（中国省级用 ISO 3166-2 的 CN-XX，其他国家用两位国家码）。
   设置面板拿这个列表渲染下拉，同时允许用户自己手填别的代码。
   注意：eBird 里台湾/香港/澳门是国家层级（TW / HK / MO），不是 CN-71/91/92。 */
const REGIONS = [
  { code: 'CN-11', name: '北京' }, { code: 'CN-12', name: '天津' }, { code: 'CN-13', name: '河北' },
  { code: 'CN-14', name: '山西' }, { code: 'CN-15', name: '内蒙古' }, { code: 'CN-21', name: '辽宁' },
  { code: 'CN-22', name: '吉林' }, { code: 'CN-23', name: '黑龙江' }, { code: 'CN-31', name: '上海' },
  { code: 'CN-32', name: '江苏' }, { code: 'CN-33', name: '浙江' }, { code: 'CN-34', name: '安徽' },
  { code: 'CN-35', name: '福建' }, { code: 'CN-36', name: '江西' }, { code: 'CN-37', name: '山东' },
  { code: 'CN-41', name: '河南' }, { code: 'CN-42', name: '湖北' }, { code: 'CN-43', name: '湖南' },
  { code: 'CN-44', name: '广东' }, { code: 'CN-45', name: '广西' }, { code: 'CN-46', name: '海南' },
  { code: 'CN-50', name: '重庆' }, { code: 'CN-51', name: '四川' }, { code: 'CN-52', name: '贵州' },
  { code: 'CN-53', name: '云南' }, { code: 'CN-54', name: '西藏' }, { code: 'CN-61', name: '陕西' },
  { code: 'CN-62', name: '甘肃' }, { code: 'CN-63', name: '青海' }, { code: 'CN-64', name: '宁夏' },
  { code: 'CN-65', name: '新疆' },
  { code: 'TW', name: '中国台湾' }, { code: 'HK', name: '中国香港' }, { code: 'MO', name: '中国澳门' },
  { code: 'JP', name: '日本' }, { code: 'KR', name: '韩国' }, { code: 'MN', name: '蒙古' },
  { code: 'SG', name: '新加坡' }, { code: 'MY', name: '马来西亚' }, { code: 'TH', name: '泰国' },
  { code: 'VN', name: '越南' }, { code: 'PH', name: '菲律宾' }, { code: 'ID', name: '印度尼西亚' },
  { code: 'BN', name: '文莱' }, { code: 'KH', name: '柬埔寨' }, { code: 'LA', name: '老挝' },
  { code: 'MM', name: '缅甸' }, { code: 'IN', name: '印度' }, { code: 'NP', name: '尼泊尔' },
  { code: 'LK', name: '斯里兰卡' }, { code: 'BD', name: '孟加拉国' }, { code: 'PK', name: '巴基斯坦' },
  { code: 'KZ', name: '哈萨克斯坦' }, { code: 'RU', name: '俄罗斯' }, { code: 'AU', name: '澳大利亚' },
  { code: 'NZ', name: '新西兰' }, { code: 'GB', name: '英国' }, { code: 'IE', name: '爱尔兰' },
  { code: 'US', name: '美国' }, { code: 'CA', name: '加拿大' }, { code: 'MX', name: '墨西哥' },
  { code: 'BR', name: '巴西' }, { code: 'AR', name: '阿根廷' }, { code: 'CL', name: '智利' },
  { code: 'PE', name: '秘鲁' }, { code: 'CO', name: '哥伦比亚' }, { code: 'EC', name: '厄瓜多尔' },
  { code: 'CR', name: '哥斯达黎加' }, { code: 'ZA', name: '南非' }, { code: 'KE', name: '肯尼亚' },
  { code: 'TZ', name: '坦桑尼亚' }, { code: 'AE', name: '阿联酋' }, { code: 'IL', name: '以色列' },
  { code: 'TR', name: '土耳其' }, { code: 'DE', name: '德国' }, { code: 'FR', name: '法国' },
  { code: 'NL', name: '荷兰' }, { code: 'BE', name: '比利时' }, { code: 'ES', name: '西班牙' },
  { code: 'PT', name: '葡萄牙' }, { code: 'IT', name: '意大利' }, { code: 'CH', name: '瑞士' },
  { code: 'AT', name: '奥地利' }, { code: 'PL', name: '波兰' }, { code: 'CZ', name: '捷克' },
  { code: 'SE', name: '瑞典' }, { code: 'NO', name: '挪威' }, { code: 'FI', name: '芬兰' },
  { code: 'DK', name: '丹麦' },
];

const REGION_NAMES = Object.fromEntries(REGIONS.map((r) => [r.code, r.name]));

let cache = null;
let cacheDirty = false;
let cacheTimer = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  cache.tax = cache.tax || {};
  cache.obs = cache.obs || {};
  return cache;
}

/** 写盘合并成一次：连续查多个物种只落一次文件 */
function flushLater() {
  cacheDirty = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
    } catch {
      /* 缓存写不进去不影响结果 */
    }
  }, 2000);
  cacheTimer.unref?.();
}

function regionLabel(code) {
  return REGION_NAMES[code] || code;
}

function regionOf(cfg) {
  const raw = String(cfg?.region || '').trim();
  return raw || 'CN-31';
}

function tokenOf(cfg) {
  const key = String(cfg?.apiKey || '').trim();
  if (!key) throw new SiteError('eBird 未配置 API key', { status: 401 });
  return key;
}

async function ebGet(url, token, timeout = 15000) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'x-ebirdapitoken': token, accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const msg = /timeout|aborted/i.test(err.message || '') ? '请求超时' : '连不上 eBird';
    throw new SiteError(`${msg}（${err.message || err}）`, { status: 0 });
  }
  const text = await res.text();
  if (res.status === 401) throw new SiteError('eBird API key 无效', { status: 401 });
  if (res.status === 403) throw new SiteError('eBird 拒绝了请求：key 可能未通过审核或被停用', { status: 403 });
  if (res.status === 404) throw new SiteError('地区码或物种代码不存在（eBird 返回 404），检查一下地区设置', { status: 404 });
  if (res.status === 429) throw new SiteError('eBird 限流，请过一会儿再试', { status: 429 });
  if (!res.ok) throw new SiteError(`eBird 返回 ${res.status}`, { status: res.status });
  try {
    return JSON.parse(text);
  } catch {
    throw new SiteError('eBird 返回了非 JSON 内容', { status: 502 });
  }
}

/** 连通性检测：顺手把那 14 天全区最新一条记录捞出来，界面上能显示「已验证」 */
async function ping(cfg) {
  const token = tokenOf(cfg);
  const region = regionOf(cfg);
  const list = await ebGet(
    `${EBIRD_BASE}/data/obs/${encodeURIComponent(region)}/recent?back=${BACK_DAYS}&maxResults=1`,
    token,
    12000,
  );
  const one = Array.isArray(list) ? list[0] : null;
  let cn = one ? one.comName : '';
  // obs 接口不吃 locale，只能再问一次学名换中文
  if (one?.sciName) {
    try {
      const tax = await taxLookup([one.sciName], token);
      cn = tax[one.sciName.toLowerCase()]?.comName || cn;
    } catch {
      /* 拿不到中文名不影响「已连接」 */
    }
  }
  return {
    ok: true,
    region,
    regionLabel: regionLabel(region),
    sample: one ? { cn, latin: one.sciName, at: one.obsDt, loc: one.locName } : null,
  };
}

/**
 * 坐标 → eBird 地区码（前端「点 eBird 弹出地区选择」用）。
 *
 * 不自己维护一份「经纬度 → 省份」的表：eBird 的 /ref/hotspot/geo 会返回指定半径内的
 * 观鸟热点，每条都自带 subnational1Code（中国就是 CN-XX）和 countryCode，
 * 等于让 eBird 自己回答「这块坐标算哪个省 / 哪个国家」，比本地硬编码的省会坐标准得多。
 * 半径由小到大试（海上、荒漠 25km 内可能一个热点都没有），取出现次数最多的那个码。
 */
async function regionAt(cfg, lat, lng) {
  const token = tokenOf(cfg);
  const y = Number(lat);
  const x = Number(lng);
  if (!Number.isFinite(y) || !Number.isFinite(x) || Math.abs(y) > 90 || Math.abs(x) > 180) {
    throw new SiteError('坐标不合法', { status: 400 });
  }
  let lastErr = null;
  for (const dist of [25, 80, 200, 500]) {
    let list;
    try {
      list = await ebGet(
        `${EBIRD_BASE}/ref/hotspot/geo?fmt=json&lat=${y.toFixed(4)}&lng=${x.toFixed(4)}&dist=${dist}`,
        token,
        12000,
      );
    } catch (err) {
      // 401 / 429 这类重试也没用，直接抛给前端提示
      lastErr = err;
      break;
    }
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) continue;
    const tally = new Map(); // 地区码 → { n, country }
    for (const h of arr) {
      // 字段名就是小写 n 的 subnational1Code（不是 subNational1Code）；
      // 香港/新加坡这类没有下级行政区的会给个 "HK-" 的空尾巴，去掉再算。
      const code = String(h.subnational1Code || h.countryCode || '').trim().replace(/-+$/, '');
      if (!code) continue;
      const cur = tally.get(code) || { n: 0, country: String(h.countryCode || '').trim() };
      cur.n += 1;
      tally.set(code, cur);
    }
    if (!tally.size) continue;
    const [code, info] = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    // 列表里没有的下级代码（JP-13、GB-ENG）用国家名兜底，界面上不会只显示一串代码
    const name = REGION_NAMES[code] || REGION_NAMES[info.country] || code;
    return { code, country: info.country, name, dist, hotspots: arr.length, hits: info.n };
  }
  if (lastErr) throw lastErr;
  return { code: '', country: '', name: '', dist: 500, hotspots: 0 };
}

/** 学名 → speciesCode（批量一次请求，命中缓存的不再问） */
async function taxLookup(names, token) {
  const c = loadCache();
  const now = Date.now();
  const out = {};
  const need = [];
  for (const name of names) {
    const k = String(name || '').trim().toLowerCase();
    if (!k) continue;
    const hit = c.tax[k];
    if (hit && now - hit.at < TAX_TTL) out[k] = hit;
    else need.push(name.trim());
  }
  if (need.length) {
    const url = `${EBIRD_BASE}/ref/taxonomy/ebird?fmt=json&locale=zh_SIM&species=${encodeURIComponent(need.join(','))}`;
    const list = await ebGet(url, token);
    const byLower = new Map();
    for (const it of Array.isArray(list) ? list : []) {
      byLower.set(String(it.sciName || '').toLowerCase(), it);
    }
    for (const name of need) {
      const k = name.toLowerCase();
      const it = byLower.get(k);
      // 查不到（多半不是鸟）也记下来，免得每次都白问一次
      const entry = it
        ? { code: it.speciesCode, comName: it.comName, sciName: it.sciName, at: now }
        : { code: '', at: now };
      c.tax[k] = entry;
      out[k] = entry;
    }
    flushLater();
  }
  return out;
}

/** 单个物种近 14 天记录 */
async function obsOf(code, region, token) {
  const c = loadCache();
  const key = `${region}|${code}`;
  const now = Date.now();
  const hit = c.obs[key];
  if (hit && now - hit.at < OBS_TTL) return { ...hit, cached: true };

  const url = `${EBIRD_BASE}/data/obs/${encodeURIComponent(region)}/recent/${encodeURIComponent(code)}?back=${BACK_DAYS}&maxResults=100`;
  const list = await ebGet(url, token, 15000);
  const arr = Array.isArray(list) ? list : [];
  let last = '';
  let lastLoc = '';
  for (const it of arr) {
    if (!last || String(it.obsDt) > last) {
      last = String(it.obsDt || '');
      lastLoc = it.locName || '';
    }
  }
  const entry = { count: arr.length, capped: arr.length >= 100, last, lastLoc, at: now };
  c.obs[key] = entry;
  flushLater();
  return { ...entry, cached: false };
}

/**
 * 核对一批学名在本地区的近期记录。
 * 返回每条的：是否有代码、记录条数、最近一次的时间地点。
 */
async function check(cfg, sciNames) {
  const token = tokenOf(cfg);
  const region = regionOf(cfg);
  const names = [...new Set((sciNames || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, MAX_LOOKUP);
  if (!names.length) return { region, regionLabel: regionLabel(region), back: BACK_DAYS, items: [] };

  const tax = await taxLookup(names, token);
  const birds = names.filter((n) => tax[n.toLowerCase()]?.code);
  const stats = {};
  await Promise.all(
    birds.map(async (n) => {
      const code = tax[n.toLowerCase()].code;
      try {
        stats[code] = await obsOf(code, region, token);
      } catch (err) {
        stats[code] = { error: err.message, count: null, at: Date.now() };
      }
    }),
  );

  const items = names.map((name) => {
    const t = tax[name.toLowerCase()] || {};
    if (!t.code) {
      return { latin: name, isBird: false, note: 'eBird 只收录鸟类，这条不在鸟类名录里' };
    }
    const s = stats[t.code] || {};
    return {
      latin: name,
      comName: t.comName,
      code: t.code,
      isBird: true,
      count: s.count,
      capped: !!s.capped,
      last: s.last || '',
      lastLoc: s.lastLoc || '',
      error: s.error || '',
    };
  });

  return { region, regionLabel: regionLabel(region), back: BACK_DAYS, items };
}

module.exports = { ping, check, regionAt, regionLabel, regionOf, REGIONS, DEFAULT_REGION: 'CN-31', BACK_DAYS };
