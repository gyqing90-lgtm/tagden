'use strict';

/**
 * GBIF 检索 + DeepSeek 归纳
 *
 * 用户在结果里点「GBIF·DS」，问的是：**这个属在这个地区有哪些种**。
 *
 * 为什么不是「把问题原样丢给 DeepSeek」：
 *   模型的属种知识是训练语料里的，问它「Rhododendron 在福建有哪些种」，
 *   它会给你一份读起来很顺、但物种名和分布都可能编错的清单。分类学里一个错学名
 *   比没有答案更糟。所以这里的顺序是反过来的 ——
 *
 *     ① 先向 GBIF 要**实证数据**：属内有哪几种、该地区各有几条记录（可核查、可回溯）
 *     ② 再把这份清单交给 DeepSeek：配中文名、写归纳、指出明显缺漏
 *
 *   学名一律以 GBIF 返回的为准（模型只许照抄，不许替换）。
 *   中文名分三级：**iNaturalist 优先** → 取不到才让 DeepSeek 补 → 都没有就留空。
 *   iNat 上的俗名是全球志愿者一条条投票出来的，比模型凭语料回忆可靠得多，
 *   而且能追溯（同名精确匹配，模糊命中一律不认）。
 *   模型额外补的种单独放在 extra 里、界面上明确标成「模型补充」。
 *   这样「准」和「全」分开，谁说的哪句话都看得清。
 *
 * GBIF 侧踩过的坑（都实测过，改动前先看这里）：
 *   · 属内种列表要用 /species/search?highertaxonKey=…，不是 /species?highertaxonKey=…
 *     （后者会无视 highertaxonKey，返回界/门这种顶层节点）
 *   · 多义属必须带 kingdom：Ficus（桑科/䗉螺）、Pieris（马醉木/粉蝶）不带就匹配不到，
 *     带上 kingdom=Plantae 才有结果 —— 所以调用方要按当前识别类群传 kingdom
 *   · 中国的省级字段中英混着存，而且近年的数据以**中文省名**为主
 *     （福建 896 条 vs Fujian 136 条），所以要多个别名一起 OR 查
 *   · stateProvince 是自由文本，只能筛到省；市/县这一级 GBIF 没有稳定字段，
 *     这里退到省级并在结果里写明，不假装精确
 */

const BASE = 'https://api.gbif.org/v1';
const DS_URL = 'https://api.deepseek.com/chat/completions';
const UA = 'bio-id-hub (local species tool)';

/** 一次最多取多少个属内种（Carex 这种两千多种的属，三页足够覆盖常见种） */
const MAX_SPECIES_PAGES = 3;
const PAGE_SIZE = 1000;

/* ---------------- 省级别名 ----------------
 * GBIF 里中国的省名有三种写法混用：中文（福建）、拼音（Fujian）、
 * 以及早期文献的威妥玛拼法（Fukien）。查的时候三种一起 OR，才不会漏。
 * 顺序有意义：中文放第一位，实测覆盖最多。
 */
const PROV_ALIAS = {
  北京市: ['北京', 'Beijing', 'Peking'],
  天津市: ['天津', 'Tianjin'],
  河北省: ['河北', 'Hebei'],
  山西省: ['山西', 'Shanxi'],
  内蒙古自治区: ['内蒙古', 'Inner Mongolia', 'Nei Mongol'],
  辽宁省: ['辽宁', 'Liaoning'],
  吉林省: ['吉林', 'Jilin'],
  黑龙江省: ['黑龙江', 'Heilongjiang'],
  上海市: ['上海', 'Shanghai'],
  江苏省: ['江苏', 'Jiangsu', 'Kiangsu'],
  浙江省: ['浙江', 'Zhejiang', 'Chekiang'],
  安徽省: ['安徽', 'Anhui', 'Anhwei'],
  福建省: ['福建', 'Fujian', 'Fukien'],
  江西省: ['江西', 'Jiangxi', 'Kiangsi'],
  山东省: ['山东', 'Shandong', 'Shantung'],
  河南省: ['河南', 'Henan'],
  湖北省: ['湖北', 'Hubei'],
  湖南省: ['湖南', 'Hunan'],
  广东省: ['广东', 'Guangdong', 'Kwangtung'],
  广西壮族自治区: ['广西', 'Guangxi', 'Kwangsi'],
  海南省: ['海南', 'Hainan'],
  重庆市: ['重庆', 'Chongqing'],
  四川省: ['四川', 'Sichuan', 'Szechwan'],
  贵州省: ['贵州', 'Guizhou', 'Kweichow'],
  云南省: ['云南', 'Yunnan'],
  西藏自治区: ['西藏', 'Xizang', 'Tibet'],
  陕西省: ['陕西', 'Shaanxi', 'Shensi'],
  甘肃省: ['甘肃', 'Gansu', 'Kansu'],
  青海省: ['青海', 'Qinghai'],
  宁夏回族自治区: ['宁夏', 'Ningxia'],
  新疆维吾尔自治区: ['新疆', 'Xinjiang', 'Sinkiang'],
  台湾省: ['台湾', 'Taiwan'],
  香港特别行政区: ['香港', 'Hong Kong', 'Hongkong'],
  澳门特别行政区: ['澳门', 'Macau', 'Macao'],
};

/** 省级全称 → 别名数组（也接受「福建」这种已经去了后缀的写法） */
function provinceAliases(pro) {
  const s = String(pro || '').trim();
  if (!s) return [];
  if (PROV_ALIAS[s]) return PROV_ALIAS[s];
  for (const [full, list] of Object.entries(PROV_ALIAS)) {
    if (full.startsWith(s) || s.startsWith(full.replace(/(省|市|自治区|特别行政区|维吾尔|壮族|回族|藏族)/g, ''))) {
      return list;
    }
  }
  // 表里没有的自定义省名：中文原名本身照样能用
  return /[\u4e00-\u9fa5]/.test(s) ? [s] : [];
}

/** 学名 → 属名（`Rhododendron championiae` → `Rhododendron`） */
function genusOf(latin) {
  const s = String(latin || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const first = s.split(' ')[0];
  return /^[A-Z][a-z-]+$/.test(first) ? first : '';
}

/* ---------------- 缓存 ----------------
 * 属内种名单基本不变（按天缓存），地区分布一天也不会翻覆（按小时）。
 * 都放在进程内存里，重启即空 —— 这东西不需要落盘。
 */
const memo = new Map();

function cacheKey(parts) {
  return parts.join('|');
}

async function memoize(key, ttlMs, fn) {
  const hit = memo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: now, value });
  // 简单上限：超过 400 条就把最早的清掉
  if (memo.size > 400) {
    const oldest = [...memo.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) memo.delete(k);
  }
  return value;
}

function clearCache() {
  memo.clear();
}

/**
 * GET 一个 GBIF 接口。
 * 429 / 5xx 是 GBIF 侧的临时状况（它对同一来源有速率限制），重试一次基本就过；
 * 重试还不行就把错误抛出去 —— 绝不能悄悄当成「这个地区没有记录」。
 */
async function getJson(url, { retry = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      // 连不上 / TLS 抖动 / 超时：网络层的失败也该重试，不然一次抖动就白跑
      if (attempt < retry) {
        await new Promise((r) => setTimeout(r, 600 + attempt * 1200));
        continue;
      }
      throw new Error(`连不上 GBIF（${err.cause?.code || err.name || err.message}）`);
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`GBIF 返回的不是 JSON：${text.slice(0, 80)}`);
      }
    }
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < retry) {
      await new Promise((r) => setTimeout(r, 600 + attempt * 1200));
      continue;
    }
    let msg = text.slice(0, 120);
    try {
      msg = JSON.parse(text).message || msg;
    } catch {
      /* 原样 */
    }
    throw new Error(`GBIF HTTP ${res.status}：${msg}`);
  }
}

/**
 * 属名 → GBIF 的 usageKey。
 * kingdom 必须给：Ficus / Pieris 这类同名属不带界就会匹配失败（实测返回空对象）。
 */
async function matchGenus(genus, kingdom) {
  const name = String(genus || '').trim();
  if (!name) throw new Error('缺属名');
  // 知道类群就按类群定界；不知道（通用组）就植物→动物→真菌依次试，
  // 同名属里植物最常见，所以 Plantae 排第一
  const kds = ['Plantae', 'Animalia', 'Fungi'].includes(kingdom) ? [kingdom] : ['Plantae', 'Animalia', 'Fungi'];
  return memoize(cacheKey(['match', name, kds.join('/')]), 7 * 24 * 3600 * 1000, async () => {
    const tries = [...kds.map((k) => `&kingdom=${k}`), ''];
    for (const extra of tries) {
      const j = await getJson(`${BASE}/species/match?name=${encodeURIComponent(name)}&rank=GENUS${extra}`);
      if (j && j.usageKey && j.rank === 'GENUS') {
        // GBIF 把不少老属判成异名（实测 Hysteroscene → Piarosoma）。异名那个 usageKey
        // 底下没有接受名种，拿它去查 species/search 和 occurrence facet 全是 0 ——
        // 看着像「该地区没分布」，其实是查错了 key。跟着 acceptedUsageKey 走。
        const isSynonym = /SYNONYM|HETEROTYPIC|HOMOTYPIC/i.test(String(j.status || ''));
        const acceptedKey = Number(j.acceptedUsageKey) || 0;
        return {
          usageKey: isSynonym && acceptedKey ? acceptedKey : j.usageKey,
          // 界面上仍写用户点的那个属名，异名关系另给字段说明
          genus: j.canonicalName || name,
          family: j.family || '',
          kingdom: j.kingdom || '',
          status: j.status || '',
          isSynonym: isSynonym && acceptedKey > 0,
          acceptedGenus: isSynonym && acceptedKey ? String(j.genus || j.accepted || '') : '',
        };
      }
    }
    return null;
  });
}

/**
 * 属内接受名种的**总数**（只要数字，不要清单）。
 * limit=0 的查询很轻（不到 1 秒），拿它算「全球多少个种」就够，
 * 不需要为了一个数字把上千个种的名字全拉下来。
 */
async function genusCount(usageKey) {
  return memoize(cacheKey(['count', usageKey]), 7 * 24 * 3600 * 1000, async () => {
    const j = await getJson(
      `${BASE}/species/search?highertaxonKey=${usageKey}&rank=SPECIES&status=ACCEPTED&limit=0`,
    );
    return { total: Number(j.count) || 0 };
  });
}

/**
 * 单个 speciesKey → 学名 + 科。
 *
 * 为什么按 key 一个个查，而不是先把这个属的种全拉一遍：
 * 大属（Rhododendron 1200+、Carabus 1000+）用 /species/search?limit=1000 一次要
 * 30 秒以上，直接撞上请求超时，「GBIF·DS」在杜鹃、步甲这类常见属上根本出不来结果。
 * 而结果表本来只关心**该地区有记录的那些种**（几十个），挨个查反而只要几秒。
 */
async function speciesInfo(key) {
  return memoize(cacheKey(['spinfo', key]), 30 * 24 * 3600 * 1000, async () => {
    const d = await getJson(`${BASE}/species/${key}`);
    return {
      key,
      latin: d && d.canonicalName ? d.canonicalName : '',
      family: (d && d.family) || '',
    };
  });
}

/** 属内全部接受名种（分页取，最多三页；大属很慢，query() 已经不用它了，留着给排查用） */
async function genusSpecies(usageKey) {
  return memoize(cacheKey(['sp', usageKey]), 24 * 3600 * 1000, async () => {
    const out = [];
    let total = 0;
    for (let page = 0; page < MAX_SPECIES_PAGES; page++) {
      const url =
        `${BASE}/species/search?highertaxonKey=${usageKey}&rank=SPECIES&status=ACCEPTED` +
        `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
      const j = await getJson(url);
      total = j.count || 0;
      const list = j.results || [];
      for (const s of list) {
        if (!s.key || !s.canonicalName) continue;
        out.push({ key: s.key, latin: s.canonicalName, family: s.family || '' });
      }
      if (list.length < PAGE_SIZE || out.length >= total) break;
    }
    return { total, list: out };
  });
}

/**
 * 该地区有记录的种（speciesKey + 记录条数）。
 * 省级用多个别名 OR 查（GBIF 同参数出现多次是「或」），国家级只给 country。
 */
async function regionFacet(usageKey, where) {
  const country = String(where.country || '').toUpperCase();
  const provinces = (where.provinces || []).filter(Boolean);
  const key = cacheKey(['facet', usageKey, country, provinces.join(',')]);
  return memoize(key, 6 * 3600 * 1000, async () => {
    const params = [`taxonKey=${usageKey}`, 'facet=speciesKey', 'facetLimit=300', 'limit=0'];
    if (country) params.push(`country=${country}`);
    for (const p of provinces) params.push('stateProvince=' + encodeURIComponent(p));
    const j = await getJson(`${BASE}/occurrence/search?${params.join('&')}`);
    const facet = (j.facets || []).find((f) => f.field === 'SPECIES_KEY' || f.field === 'speciesKey');
    const counts = facet ? facet.counts : [];
    return {
      records: j.count || 0,
      species: counts.map((c) => ({ key: Number(c.name), count: c.count })),
    };
  });
}

/**
 * 完整的「属 × 地区」检索。
 *
 * region 由 server.js 用 lib/ppbc.js 的 resolveRegion 算好传进来：
 *   { inChina, pro, didian, name, code }
 * 中国按省筛（市/县这一级 GBIF 没有稳定字段），境外按国家码筛。
 */
async function query({ genus, kingdom, region }) {
  const g = String(genus || '').trim();
  if (!g) throw new Error('缺属名');

  const matched = await matchGenus(g, kingdom);
  if (!matched) {
    throw new Error(`GBIF 里没匹配到「${g}」这个属${kingdom ? `（${kingdom}）` : ''}，可能属名拼写有误`);
  }

  const regionName = String(region?.name || '').trim();
  // 国家码只认两位 ISO；「全世界」「WORLD」这类不是国家，当作不筛国家（全球）
  const rawCode = String(region?.code || '').trim().toUpperCase();
  const country = region?.inChina ? 'CN' : /^[A-Z]{2}$/.test(rawCode) ? rawCode : '';
  const provinces = region?.inChina && region?.pro ? provinceAliases(region.pro) : [];

  // 总数和「地区有记录的种」两件事可以同时问，互不依赖
  const [meta, facetRes] = await Promise.all([
    genusCount(matched.usageKey).catch(() => ({ total: 0 })),
    regionFacet(matched.usageKey, { country, provinces }).then(
      (v) => ({ ok: true, value: v }),
      // 查询失败 ≠ 该地区没有分布：把错误如实带出去，界面要区分这两种情况
      (err) => ({ ok: false, error: err.message || 'GBIF 记录查询失败' }),
    ),
  ]);

  const facet = facetRes.ok ? facetRes.value : { records: 0, species: [] };
  const facetError = facetRes.ok ? '' : facetRes.error;

  // 只给「这个地区有记录」的那些种查名字（几十个，几秒就够了）。
  // 并发 8 路：再多的话 GBIF 会开始限速，反而更慢。
  const picked = facet.species;
  const got = new Array(picked.length);
  let cursor = 0;
  async function nameWorker() {
    while (cursor < picked.length) {
      const i = cursor++;
      const s = picked[i];
      try {
        const info = await speciesInfo(s.key);
        if (info.latin) got[i] = { latin: info.latin, family: info.family, count: s.count, key: s.key };
      } catch {
        /* 单个查不到就跳过这个种，不影响主表 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, picked.length) }, nameWorker));

  const rows = got.filter(Boolean);

  // 记录多的排前面：常见种天然靠前，也顺便说明「谁在这个地区被采得多」
  rows.sort((a, b) => b.count - a.count || a.latin.localeCompare(b.latin));

  return {
    genus: matched.genus,
    family: matched.family,
    kingdom: matched.kingdom,
    usageKey: matched.usageKey,
    isSynonym: Boolean(matched.isSynonym),
    acceptedGenus: matched.acceptedGenus || '',
    globalTotal: meta.total,
    listedTotal: rows.length,
    regionName,
    scope: describeScope(region, provinces),
    level: provinces.length ? 'province' : country ? 'country' : 'world',
    records: facet.records,
    species: rows,
    facetError,
    note: scopeNote(region, provinces, country),
  };
}

/** 界面上一句话说明「GBIF 实际按哪个范围筛的」 */
function describeScope(region, provinces) {
  const name = String(region?.name || '').trim();
  if (!region?.inChina) {
    const c = String(region?.code || '').toUpperCase();
    return c ? `${name || c}（${c}）` : name || '全球';
  }
  if (provinces.length) return region.pro;
  return name || '中国';
}

function scopeNote(region, provinces, country) {
  if (!country) {
    // 用户自己选的就是「全世界」，别提示成「没拿到国家」
    return /全世界|全球/.test(String(region?.name || ''))
      ? '范围：全球（没有限定国家或地区），所以列的是全世界有记录的种。'
      : '没拿到国家/省份，这一份按全球范围的记录统计，仅供参考。';
  }
  if (region?.inChina && provinces.length && region?.didian) {
    return `GBIF 的省/市字段是自由文本，只能稳定筛到省这一级：下面列的是「${region.pro}」全省有记录的种${
      region.didian ? `，不是只看${region.didian}` : ''
    }。市县一级请结合下面的分布说明判断。`;
  }
  if (region?.inChina && provinces.length) return `范围：${region.pro}全省（GBIF 有记录的种）。`;
  return '';
}

/* ---------------- 中文名：iNaturalist 优先 ----------------
 *
 * iNat 的 /v1/taxa?q=<学名>&locale=zh-CN 会回该分类单元的 preferred_common_name。
 * 几个必须注意的点（都实测过）：
 *   · 必须带 locale=zh-CN，否则拿到的是英文俗名；
 *   · 没有中文名的种会**回退成英文**，所以还要过一遍中文正则，不能拿到就用；
 *   · q= 是模糊搜索，会返回一堆近似种，必须比对 name 与问的名字完全一致
 *     （「Tolmerus ningqiangensis」能搜出别的 Tolmerus，张冠李戴比留空更糟）；
 *   · 未登录限速约 100 次/分钟，一个属几十上百个种时容易撞上 429，
 *     所以并发限 6 路，撞上了就当场收手 —— 剩下的交给 DeepSeek，不硬刚。
 *
 * 命中和「确认没有」都进内存缓存：同一个属再看一次、或者换个地区再看，
 * 都不会重复请求。有名字的缓存 60 天，确认没有的只缓存 3 天（iNat 上随时可能有人补）。
 */

const INAT_TAXA = 'https://api.inaturalist.org/v1/taxa';
const INAT_UA = 'bio-id-hub (local desktop tool)';
const INAT_CONC = 6;
/** 一次最多给多少个种补中文名（再多的排后面由模型兜） */
const INAT_CN_MAX = 120;

const CN_CACHE = new Map(); // 学名小写 → { at, cn }（cn='' 表示确认没有）
const CN_TTL_OK = 60 * 24 * 3600 * 1000;
const CN_TTL_MISS = 3 * 24 * 3600 * 1000;

/** 认不认这个「中文名」：必须真有汉字，纯拉丁/希腊字母一律不算（英文回退就是这么漏进来的） */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function normLatin(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

function cnCached(key) {
  const hit = CN_CACHE.get(key);
  if (!hit) return undefined;
  const ttl = hit.cn ? CN_TTL_OK : CN_TTL_MISS;
  if (Date.now() - hit.at > ttl) {
    CN_CACHE.delete(key);
    return undefined;
  }
  return hit.cn;
}

function inatCnHit() {
  return CN_CACHE.size;
}

/**
 * 从 iNat 的 taxon 记录里挑一个中文名。
 *
 * preferred_common_name 只给「当前 locale 最优先的那一个」，实测经常挑到繁体
 * （Papilio nephelus 回「寬帶鳳蝶」，而同一个种在 names 里就有简体的「白斑美凤蝶」）。
 * 所以带 all_names=true 把全部俗名要回来，按 zh-CN → zh（含 zh-TW）→ preferred 的顺序挑，
 * 同一档里按 position 小的优先（position 0 是学名，前面已用 CJK 正则挡掉）。
 */
function pickChineseName(t) {
  const names = Array.isArray(t && t.names) ? t.names : [];
  const rank = (n) => (typeof n.position === 'number' ? n.position : 999);
  const usable = names.filter((n) => n && CJK.test(String(n.name || '')));
  const tiers = [/^zh-CN/i, /^zh/i];
  for (const re of tiers) {
    const hit = usable.filter((n) => re.test(String(n.locale || ''))).sort((a, b) => rank(a) - rank(b))[0];
    if (hit) return normLatin(hit.name);
  }
  const pref = normLatin(t && t.preferred_common_name);
  return pref && CJK.test(pref) ? pref : '';
}

/** 查一个学名的中文名。命中回字符串，确认没有回 ''；429 抛 rateLimited 让上层收手 */
async function inatNameOne(latin) {
  const q = normLatin(latin);
  if (!q) return '';
  const key = q.toLowerCase();
  const cached = cnCached(key);
  if (cached !== undefined) return cached;

  const url = `${INAT_TAXA}?q=${encodeURIComponent(q)}&rank=species&per_page=5&locale=zh-CN&all_names=true`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': INAT_UA, accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    throw new Error(`iNaturalist 连不上（${err.cause?.code || err.name || err.message}）`);
  }
  if (res.status === 429) {
    const e = new Error('iNaturalist 限流了');
    e.rateLimited = true;
    throw e;
  }
  if (!res.ok) throw new Error(`iNaturalist HTTP ${res.status}`);

  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error('iNaturalist 返回的不是 JSON');
  }

  let cn = '';
  for (const t of j.results || []) {
    if (normLatin(t.name).toLowerCase() !== key) continue; // 模糊命中不认
    cn = pickChineseName(t);
    break;
  }
  CN_CACHE.set(key, { at: Date.now(), cn });
  return cn;
}

/**
 * 给一批种补中文名。
 * @returns {{map: Object<string,string>, tried: number, stopped: boolean}}
 *   map 以**传进来的学名原样**为键（前端按学名查，不能是归一化后的）
 */
async function inatChineseNames(rows, { limit = INAT_CN_MAX } = {}) {
  const map = {};
  const todo = [];
  const seen = new Set();

  for (const r of (rows || []).slice(0, limit)) {
    const q = normLatin(r && r.latin);
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = cnCached(key);
    if (cached === undefined) todo.push(q);
    else if (cached) map[q] = cached;
  }

  let cursor = 0;
  let stop = false;
  let stopped = false;

  async function worker() {
    while (!stop) {
      const i = cursor++;
      if (i >= todo.length) return;
      const name = todo[i];
      try {
        const cn = await inatNameOne(name);
        if (cn) map[name] = cn;
      } catch (err) {
        // 限流就整体收手；单个失败（网络抖动）跳过这一个，不影响其它种
        if (err.rateLimited) {
          stop = true;
          stopped = true;
          return;
        }
      }
    }
  }

  const lanes = Math.min(INAT_CONC, todo.length);
  if (lanes > 0) await Promise.all(Array.from({ length: lanes }, worker));

  return { map, tried: Math.min(cursor, todo.length), stopped };
}

/**
 * 在一张「学名 → 中文名」表里查，容忍模型写成「R. simsii」这种缩写。
 * 服务端和前端用同一套规则，两边算出来的结论才一致。
 */
function abbrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^([a-z])[a-z-]+\.?\s+/, '$1 ');
}

function lookupCn(map, latin) {
  if (!map || !latin) return '';
  const direct = map[latin];
  if (direct) return direct;
  const want = abbrName(latin);
  for (const k of Object.keys(map)) {
    if (map[k] && abbrName(k) === want) return map[k];
  }
  return '';
}

/* ---------------- DeepSeek ---------------- */

const SYSTEM_PROMPT = `你是生物分类学助手，为「物种鉴定聚合台」回答「某属在某地区有哪些种」。

硬规矩：
1. 学名只能照抄下面 GBIF 数据里给的写法，一个字都不许改、不许替换成你认为更正确的名字。
2. 清单里标了「中文名：xxx（iNaturalist，沿用）」的，直接沿用，一个字都不要改，也不用再写进 cn。
3. 你只需要给标了「中文名：待补」的那些配通行中文名；拿不准就留空字符串，宁缺勿编，不要硬凑。
4. 如果 GBIF 明显漏掉了该地区常见的种，可以写进 extra，但必须是你有把握的；宁少不滥。
5. 全部输出一个 JSON 对象，不要 markdown、不要解释。`;

/**
 * 把 GBIF 结果压成给模型的清单（太长就只给记录最多的那些）。
 * 已经有 iNaturalist 中文名的直接标成「沿用」—— 少一道模型改写，就少一处出错的机会。
 */
function listForModel(rows, known, limit = 80) {
  return rows
    .slice(0, limit)
    .map((r, i) => {
      const cn = lookupCn(known, r.latin);
      const tail = cn ? `中文名：${cn}（iNaturalist，沿用）` : '中文名：待补';
      return `${i + 1}. ${r.latin}${r.family ? `（${r.family}）` : ''} — ${r.count} 条记录 — ${tail}`;
    })
    .join('\n');
}

/**
 * 让 DeepSeek 归纳。
 * 注意：它的产出只用来「补中文名 + 写总结 + 补缺漏」，不参与学名的确定。
 * known 是从 iNaturalist 已经拿到的中文名，模型只需要填空缺的部分。
 */
async function ask({ apiKey, model, question, data, known }) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('还没配置 DeepSeek API Key，先在「账号设置」里填一个');

  const payload = {
    model: model || 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(question, data, known) },
    ],
    temperature: 0.2,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    stream: false,
  };

  let res;
  try {
    res = await fetch(DS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    // 网络层抖动重试一次再放弃
    await new Promise((r) => setTimeout(r, 800));
    try {
      res = await fetch(DS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000),
      });
    } catch (err2) {
      throw new Error(`连不上 DeepSeek（${err2.cause?.code || err2.name || err2.message}）`);
    }
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || msg;
    } catch {
      /* 原样返回 */
    }
    throw new Error(`DeepSeek HTTP ${res.status}：${msg}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('DeepSeek 返回的不是 JSON');
  }
  const content = body.choices?.[0]?.message?.content || '';
  const parsed = parseModelJson(content);
  return {
    summary: String(parsed.summary || '').trim(),
    cn: parsed.cn && typeof parsed.cn === 'object' ? parsed.cn : {},
    extra: Array.isArray(parsed.extra) ? parsed.extra.filter((x) => x && x.latin) : [],
    usage: body.usage || null,
    model: body.model || payload.model,
  };
}

function buildUserPrompt(question, data, known) {
  const rows = data.species || [];
  const head = rows.length
    ? `GBIF 检索结果（属：${data.genus}${data.family ? '，科：' + data.family : ''}；全球共 ${data.globalTotal} 个接受名种；` +
      `范围内 ${rows.length} 种有记录，合计 ${data.records} 条记录）：\n${listForModel(rows, known)}`
    : `GBIF 检索结果：属 ${data.genus} 全球 ${data.globalTotal} 个接受名种，但**在该范围内没有任何记录**。`;
  const scopeLine = data.note ? `\n范围说明：${data.note}` : '';
  const more =
    rows.length > 80 ? `\n（只列了记录最多的 80 种，其余 ${rows.length - 80} 种略）` : '';
  const miss = rows.slice(0, 80).filter((r) => !lookupCn(known, r.latin)).length;
  const cnLine = miss
    ? `\n其中 ${miss} 个种的中文名标着「待补」，这才是你要填的部分；标了「沿用」的别动。`
    : '\n清单里每个种都已有 iNaturalist 的中文名，cn 直接给空对象 {} 即可，专心写 summary。';

  return `用户的原始问题：${question}

${head}${more}${scopeLine}${cnLine}

请输出这个 JSON：
{
  "summary": "3-5 句中文。先说这个属在范围内 GBIF 记录到多少种、全球多少种；再说分布特点或常见种；若数据明显偏少要直说「GBIF 在该地区的记录不完整」",
  "cn": {"学名（照抄清单里标了待补的那些）": "中文名"},
  "extra": [{"latin": "学名", "cn": "中文名", "note": "GBIF 无记录但该地区确实有分布，一句话依据"}]
}`;
}

/** 模型有时会裹一层 ```json，或者前后带客套话，这里都剥掉 */
function parseModelJson(content) {
  let s = String(content || '').trim();
  if (!s) return {};
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const l = s.indexOf('{');
    const r = s.lastIndexOf('}');
    if (l >= 0 && r > l) {
      try {
        return JSON.parse(s.slice(l, r + 1));
      } catch {
        /* 落空 */
      }
    }
    return {};
  }
}

module.exports = {
  BASE,
  PROV_ALIAS,
  provinceAliases,
  genusOf,
  matchGenus,
  genusSpecies,
  regionFacet,
  query,
  ask,
  inatNameOne,
  inatChineseNames,
  inatCnHit,
  lookupCn,
  clearCache,
  parseModelJson,
};
