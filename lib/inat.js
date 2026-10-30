'use strict';

/**
 * iNaturalist 助手：把「鉴定出来的学名」变成一条能直接落到
 * 「这个属在我这个地区有多少种」的 Explore 深链。
 *
 * 为什么不直接跳物种页
 * --------------------
 * 直接跳到 /taxa/<种> 只看到那一个种，回答不了「这地方到底有几种」。
 * 观鸟、拍虫的人真正想确认的是：**本地这个属有几个种、我认的这个是不是最像的那个**。
 * 所以链接落在 观察搜索（Explore）的「物种」视图上：
 *
 *   https://www.inaturalist.org/observations?locale=zh-CN&place_id=54517&taxon_id=55690&view=species
 *   └ 观察搜索          └ 简体中文界面   └ 圈定地区 └ 属          └ 物种视图（顶栏显示 N 种）
 *
 * 这三段正好对应手工操作：过滤器 → 更多过滤器 → 地点；搜索框输入属名；点「物种」标签。
 *
 * 属名 → taxon_id 需要查一次接口（属名可能有同名，比如 Pieris 既是粉蝶属也是马醉木属），
 * 所以这里做了缓存 + 按类群提示（hint）挑同名的正确那个。
 */

const https = require('node:https');

/**
 * 常用检索地区：code 存进配置，placeId 拼链接用（0 = 不限地区）。
 *
 * kind 决定主页面下拉怎么分组：
 *   china 中国 / province 省级行政区与港澳台 / country 其他国家 / world 不限
 * continent 只有 country 用（界面按洲分 optgroup）。
 * 这里的 place_id 都是从 iNaturalist 的 places 接口查出来核对过的固定值；
 * 列表里没有的地方，用户可以在主页面直接搜（searchPlaces），结果按 place_id 存。
 */
const PLACES = [
  { code: 'CN', name: '中国', placeId: 6903, kind: 'china' },

  { code: 'CN-11', name: '北京', placeId: 6907, kind: 'province' },
  { code: 'CN-12', name: '天津', placeId: 12698, kind: 'province' },
  { code: 'CN-13', name: '河北', placeId: 13350, kind: 'province' },
  { code: 'CN-14', name: '山西', placeId: 12697, kind: 'province' },
  { code: 'CN-15', name: '内蒙古', placeId: 6910, kind: 'province' },
  { code: 'CN-21', name: '辽宁', placeId: 13355, kind: 'province' },
  { code: 'CN-22', name: '吉林', placeId: 13354, kind: 'province' },
  { code: 'CN-23', name: '黑龙江', placeId: 8949, kind: 'province' },
  { code: 'CN-31', name: '上海', placeId: 6904, kind: 'province' },
  { code: 'CN-32', name: '江苏', placeId: 7285, kind: 'province' },
  { code: 'CN-33', name: '浙江', placeId: 53098, kind: 'province' },
  { code: 'CN-34', name: '安徽', placeId: 65973, kind: 'province' },
  { code: 'CN-35', name: '福建', placeId: 54517, kind: 'province' },
  { code: 'CN-36', name: '江西', placeId: 57829, kind: 'province' },
  { code: 'CN-37', name: '山东', placeId: 13358, kind: 'province' },
  { code: 'CN-41', name: '河南', placeId: 13351, kind: 'province' },
  { code: 'CN-42', name: '湖北', placeId: 53105, kind: 'province' },
  { code: 'CN-43', name: '湖南', placeId: 57824, kind: 'province' },
  { code: 'CN-44', name: '广东', placeId: 53101, kind: 'province' },
  { code: 'CN-45', name: '广西', placeId: 66994, kind: 'province' },
  { code: 'CN-46', name: '海南', placeId: 7825, kind: 'province' },
  { code: 'CN-50', name: '重庆', placeId: 13345, kind: 'province' },
  { code: 'CN-51', name: '四川', placeId: 9738, kind: 'province' },
  { code: 'CN-52', name: '贵州', placeId: 53099, kind: 'province' },
  { code: 'CN-53', name: '云南', placeId: 53055, kind: 'province' },
  { code: 'CN-54', name: '西藏', placeId: 13360, kind: 'province' },
  { code: 'CN-61', name: '陕西', placeId: 13357, kind: 'province' },
  { code: 'CN-62', name: '甘肃', placeId: 13347, kind: 'province' },
  { code: 'CN-63', name: '青海', placeId: 13356, kind: 'province' },
  { code: 'CN-64', name: '宁夏', placeId: 12695, kind: 'province' },
  { code: 'CN-65', name: '新疆', placeId: 13359, kind: 'province' },
  { code: 'TW', name: '中国台湾', placeId: 7887, kind: 'province' },
  { code: 'HK', name: '中国香港', placeId: 7613, kind: 'province' },
  { code: 'MO', name: '中国澳门', placeId: 10301, kind: 'province' },

  { code: 'JP', name: '日本', placeId: 6737, kind: 'country', continent: '亚洲' },
  { code: 'KR', name: '韩国', placeId: 6891, kind: 'country', continent: '亚洲' },
  { code: 'KP', name: '朝鲜', placeId: 8432, kind: 'country', continent: '亚洲' },
  { code: 'MN', name: '蒙古', placeId: 7347, kind: 'country', continent: '亚洲' },
  { code: 'RU', name: '俄罗斯', placeId: 7161, kind: 'country', continent: '亚洲' },
  { code: 'IN', name: '印度', placeId: 6681, kind: 'country', continent: '亚洲' },
  { code: 'NP', name: '尼泊尔', placeId: 7335, kind: 'country', continent: '亚洲' },
  { code: 'BT', name: '不丹', placeId: 7707, kind: 'country', continent: '亚洲' },
  { code: 'BD', name: '孟加拉国', placeId: 7154, kind: 'country', continent: '亚洲' },
  { code: 'LK', name: '斯里兰卡', placeId: 7077, kind: 'country', continent: '亚洲' },
  { code: 'PK', name: '巴基斯坦', placeId: 7076, kind: 'country', continent: '亚洲' },
  { code: 'TH', name: '泰国', placeId: 6967, kind: 'country', continent: '亚洲' },
  { code: 'VN', name: '越南', placeId: 6847, kind: 'country', continent: '亚洲' },
  { code: 'LA', name: '老挝', placeId: 7001, kind: 'country', continent: '亚洲' },
  { code: 'KH', name: '柬埔寨', placeId: 7002, kind: 'country', continent: '亚洲' },
  { code: 'MM', name: '缅甸', placeId: 6992, kind: 'country', continent: '亚洲' },
  { code: 'MY', name: '马来西亚', placeId: 7155, kind: 'country', continent: '亚洲' },
  { code: 'SG', name: '新加坡', placeId: 6734, kind: 'country', continent: '亚洲' },
  { code: 'ID', name: '印度尼西亚', placeId: 6966, kind: 'country', continent: '亚洲' },
  { code: 'PH', name: '菲律宾', placeId: 6873, kind: 'country', continent: '亚洲' },
  { code: 'BN', name: '文莱', placeId: 7838, kind: 'country', continent: '亚洲' },
  { code: 'KZ', name: '哈萨克斯坦', placeId: 7342, kind: 'country', continent: '亚洲' },
  { code: 'UZ', name: '乌兹别克斯坦', placeId: 7352, kind: 'country', continent: '亚洲' },
  { code: 'KG', name: '吉尔吉斯斯坦', placeId: 7346, kind: 'country', continent: '亚洲' },

  { code: 'GB', name: '英国', placeId: 6857, kind: 'country', continent: '欧洲' },
  { code: 'IE', name: '爱尔兰', placeId: 6718, kind: 'country', continent: '欧洲' },
  { code: 'FR', name: '法国', placeId: 6753, kind: 'country', continent: '欧洲' },
  { code: 'DE', name: '德国', placeId: 7207, kind: 'country', continent: '欧洲' },
  { code: 'IT', name: '意大利', placeId: 6973, kind: 'country', continent: '欧洲' },
  { code: 'ES', name: '西班牙', placeId: 6774, kind: 'country', continent: '欧洲' },
  { code: 'PT', name: '葡萄牙', placeId: 7122, kind: 'country', continent: '欧洲' },
  { code: 'NL', name: '荷兰', placeId: 7506, kind: 'country', continent: '欧洲' },
  { code: 'BE', name: '比利时', placeId: 7008, kind: 'country', continent: '欧洲' },
  { code: 'CH', name: '瑞士', placeId: 7236, kind: 'country', continent: '欧洲' },
  { code: 'AT', name: '奥地利', placeId: 8057, kind: 'country', continent: '欧洲' },
  { code: 'PL', name: '波兰', placeId: 7800, kind: 'country', continent: '欧洲' },
  { code: 'CZ', name: '捷克', placeId: 8264, kind: 'country', continent: '欧洲' },
  { code: 'HU', name: '匈牙利', placeId: 7399, kind: 'country', continent: '欧洲' },
  { code: 'RO', name: '罗马尼亚', placeId: 8858, kind: 'country', continent: '欧洲' },
  { code: 'GR', name: '希腊', placeId: 7094, kind: 'country', continent: '欧洲' },
  { code: 'SE', name: '瑞典', placeId: 7599, kind: 'country', continent: '欧洲' },
  { code: 'NO', name: '挪威', placeId: 7016, kind: 'country', continent: '欧洲' },
  { code: 'FI', name: '芬兰', placeId: 7020, kind: 'country', continent: '欧洲' },
  { code: 'DK', name: '丹麦', placeId: 8051, kind: 'country', continent: '欧洲' },
  { code: 'IS', name: '冰岛', placeId: 7278, kind: 'country', continent: '欧洲' },
  { code: 'UA', name: '乌克兰', placeId: 8860, kind: 'country', continent: '欧洲' },
  { code: 'TR', name: '土耳其', placeId: 7183, kind: 'country', continent: '欧洲' },

  { code: 'US', name: '美国', placeId: 1, kind: 'country', continent: '北美洲' },
  { code: 'CA', name: '加拿大', placeId: 6712, kind: 'country', continent: '北美洲' },
  { code: 'MX', name: '墨西哥', placeId: 6793, kind: 'country', continent: '北美洲' },
  { code: 'CR', name: '哥斯达黎加', placeId: 6924, kind: 'country', continent: '北美洲' },

  { code: 'BR', name: '巴西', placeId: 6878, kind: 'country', continent: '南美洲' },
  { code: 'AR', name: '阿根廷', placeId: 7190, kind: 'country', continent: '南美洲' },
  { code: 'CL', name: '智利', placeId: 7182, kind: 'country', continent: '南美洲' },
  { code: 'PE', name: '秘鲁', placeId: 7513, kind: 'country', continent: '南美洲' },
  { code: 'CO', name: '哥伦比亚', placeId: 7196, kind: 'country', continent: '南美洲' },
  { code: 'EC', name: '厄瓜多尔', placeId: 7512, kind: 'country', continent: '南美洲' },

  { code: 'AU', name: '澳大利亚', placeId: 6744, kind: 'country', continent: '大洋洲' },
  { code: 'NZ', name: '新西兰', placeId: 6803, kind: 'country', continent: '大洋洲' },

  { code: 'EG', name: '埃及', placeId: 7055, kind: 'country', continent: '非洲 / 中东' },
  { code: 'MA', name: '摩洛哥', placeId: 7306, kind: 'country', continent: '非洲 / 中东' },
  { code: 'ZA', name: '南非', placeId: 6986, kind: 'country', continent: '非洲 / 中东' },
  { code: 'KE', name: '肯尼亚', placeId: 7042, kind: 'country', continent: '非洲 / 中东' },
  { code: 'TZ', name: '坦桑尼亚', placeId: 7144, kind: 'country', continent: '非洲 / 中东' },
  { code: 'MG', name: '马达加斯加', placeId: 7783, kind: 'country', continent: '非洲 / 中东' },
  { code: 'IL', name: '以色列', placeId: 6815, kind: 'country', continent: '非洲 / 中东' },
  { code: 'AE', name: '阿联酋', placeId: 7359, kind: 'country', continent: '非洲 / 中东' },
  { code: 'SA', name: '沙特阿拉伯', placeId: 7358, kind: 'country', continent: '非洲 / 中东' },

  { code: 'WORLD', name: '全世界（不限地区）', placeId: 0, kind: 'world' },
];

/** 国家按洲分组的顺序，前端 optgroup 就用它 */
const CONTINENTS = ['亚洲', '欧洲', '北美洲', '南美洲', '大洋洲', '非洲 / 中东'];

const DEFAULT_CODE = 'CN';

function placeOf(code) {
  const c = String(code || '').trim();
  return PLACES.find((p) => p.code === c) || PLACES.find((p) => p.code === DEFAULT_CODE);
}

function placeIdOf(code) {
  return placeOf(code).placeId;
}

function placeNameOf(code) {
  return placeOf(code).name;
}

/**
 * 配置 → 当前检索地区。两种存法：
 *   { place: 'CN-35' }                    常用列表里的地区
 *   { placeId: 222739, placeName: '…' }   用户自己搜出来的地方（城市 / 保护区 / 公园…）
 * 自定义的优先，因为它是用户最近一次主动选的。
 */
function resolvePlace(cfg) {
  const c = cfg || {};
  const id = Number(c.placeId) || 0;
  const name = String(c.placeName || '').trim();
  if (id > 0) return { code: '', name: name || `地区 #${id}`, placeId: id, custom: true };
  const hit = placeOf(c.place);
  return { code: hit.code, name: hit.name, placeId: hit.placeId, custom: false };
}

/**
 * 页面语言。**必须是 zh-CN，不能写 zh**。
 *
 * iNat 官方文档（/pages/search+urls → Change page language/locale）写的是：
 * 「代码不可用或不指定时，站点默认回退 locale=en」。而 iNat 网页端的语言代码取自
 * Crowdin 项目 inaturalistweb，中文只有 zh-CN（简体，已 100% 译完）、zh-TW（繁体）
 * 和 zh-HK —— **没有裸的 zh**。所以 locale=zh 会被当成不可用代码 → 整页英文
 * （连俗名都给英文），这正是用户看到「跳过去全英文」的原因。
 *
 * 实测（抓 https://www.inaturalist.org/ 的 html lang 与中文占比）：
 *   locale=zh     → lang=en     中文 11 字（只有页脚语言列表）
 *   locale=zh-CN  → lang=zh-CN  中文 1855 字
 *   locale=zh-TW  → lang=zh-TW  中文 1749 字（繁体）
 *   不带 locale    → lang=en-US  看浏览器语言，不保险
 */
const LOCALE = 'zh-CN';

/**
 * 学名 → 属名。取第一个词，去掉 sp. / cf. / 杂交× 这些尾巴；
 * 只认纯字母（≥3 位）的词，认不出来就返回空串（前端不显示按钮）。
 */
function genusOf(latin) {
  const raw = String(latin || '')
    .replace(/\u00d7/g, ' ')
    .trim();
  const first = raw.split(/[\s.,;()]+/)[0] || '';
  if (!/^[A-Za-z]{3,}$/.test(first)) return '';
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * 拼 Explore 深链。
 * - 有 taxon_id 就用 id（精确，不怕同名）
 * - 拿不到 id 就退回 taxon_name=（iNat 会自己解析学名，极少失败）
 * - placeId 为 0 时不带 place_id，等于全球
 */
function buildUrl({ genus, taxonId, placeId }) {
  const q = new URLSearchParams();
  q.set('locale', LOCALE);
  if (placeId) q.set('place_id', String(placeId));
  if (taxonId) q.set('taxon_id', String(taxonId));
  else q.set('taxon_name', String(genus || ''));
  q.set('view', 'species'); // 「物种」标签：顶栏直接给「N 种」
  return `https://www.inaturalist.org/observations?${q.toString()}`;
}

/* ---------------- 属名 → taxon_id ---------------- */

/**
 * 类群提示：同名属（Pieris 粉蝶 / 马醉木、Aotus 等）靠它挑对那一个。
 * 值用 iNat 的 iconic_taxon_id，ancestor_ids 里含它就算命中。
 */
const ICONIC_HINT = {
  plant: 47126,
  insect: 47158,
  bird: 3,
  mammal: 40151,
  herp: [20978, 26036],
  fungi: 47170,
  mollusk: 47115,
  animal: 1,
  general: 0,
};

const cache = new Map(); // "<属名小写>|<hint>" → { id, name, rank } | null

function getJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'bio-id-hub (local desktop tool)', Accept: 'application/json' } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`iNaturalist 返回 ${res.statusCode}`));
          try {
            resolve(JSON.parse(buf));
          } catch (err) {
            reject(new Error('iNaturalist 返回内容无法解析'));
          }
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('iNaturalist 请求超时')));
    req.on('error', reject);
  });
}

function matchHint(taxon, hint) {
  const want = ICONIC_HINT[hint];
  if (!want) return false;
  const ids = Array.isArray(want) ? want : [want];
  const anc = Array.isArray(taxon.ancestor_ids) ? taxon.ancestor_ids : [];
  const own = Number(taxon.iconic_taxon_id);
  return ids.some((id) => id === own || anc.includes(id));
}

async function lookupGenus(genus, hint) {
  const url =
    'https://api.inaturalist.org/v1/taxa?q=' +
    encodeURIComponent(genus) +
    '&rank=genus&per_page=10&locale=' +
    LOCALE;
  const j = await getJson(url);
  const hits = (j.results || []).filter((r) => String(r.name || '').toLowerCase() === genus.toLowerCase());
  if (!hits.length) return null;
  // 先按类群提示筛，筛不出来再退回「观测最多的那个」（iNat 上更活跃的通常就是大家问的那个）
  const scoped = hits.filter((h) => matchHint(h, hint));
  const pool = scoped.length ? scoped : hits;
  pool.sort((a, b) => (b.observations_count || 0) - (a.observations_count || 0));
  const best = pool[0];
  return { id: best.id, name: best.name, rank: best.rank || 'genus' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 批量解析：返回 { '<属名小写>': { id, name, rank } }。
 * 结果缓存在进程内；接口挂了就返回空对象（前端自动退回 taxon_name 链接，不影响使用）。
 */
async function resolveTaxa(names, hint = '') {
  const out = {};
  const genera = [...new Set((names || []).map(genusOf).filter(Boolean))];
  for (const g of genera) {
    const key = `${g.toLowerCase()}|${hint || ''}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, await lookupGenus(g, hint));
      } catch {
        // 网络不通 / 限流：先不写缓存，下次再试
        continue;
      }
      await sleep(120); // 未登录接口限速 100 次/分钟，慢慢来
    }
    const hit = cache.get(key);
    if (hit) out[g.toLowerCase()] = hit;
  }
  return out;
}

/* ---------------- 地区搜索（用户自己输入的地方） ---------------- */

/** place_type / admin_level → 给人看的级别名 */
function placeKindLabel(place) {
  const al = place.admin_level;
  if (al === 0) return '国家 / 地区';
  if (al === 10) return '省 / 州';
  if (al === 20) return '市 / 县';
  if (al === 30) return '区 / 镇';
  return '区域';
}

const placeCache = new Map(); // 关键词 → 结果数组（同一次会话里反复输入同一个词不重复请求）

/**
 * iNat 的中文地名常常中英粘在一起（「南平市武夷山市Wuyishan City」），
 * 放进下拉/提示条太长，这里把紧跟在中文后面的英文那段去掉；
 * 完整层级还在 display 里，候选列表第二行照样能看到。
 */
function cleanPlaceName(name) {
  const s = String(name || '').trim();
  const m = s.match(/^([\u4e00-\u9fa5][\u4e00-\u9fa5（）()·\s]*?)([A-Za-z].*)$/);
  if (m && m[1].trim().length >= 2) return m[1].trim();
  return s;
}

/**
 * 搜地区：把用户敲的地名（中文、英文都行，可以是城市 / 保护区 / 公园）
 * 变成 iNat 的 place_id。返回 [{ id, name, display, kind }]。
 *
 * 排序：标准行政区（admin_level 有值）优先，级别从高到低（国家 → 省 → 市）；
 * 同级别保持接口原本的相关性顺序（V8 的 sort 是稳定的）。
 * 这样搜「Kyoto」先给京都府、再给京都市，不会先蹦出「京都大学高菜园」。
 */
async function searchPlaces(q, limit = 8) {
  const key = String(q || '').trim();
  if (key.length < 2) return [];
  if (placeCache.has(key.toLowerCase())) return placeCache.get(key.toLowerCase());
  const url =
    'https://api.inaturalist.org/v1/places/autocomplete?q=' +
    encodeURIComponent(key) +
    '&per_page=15&locale=' +
    LOCALE;
  const j = await getJson(url);
  const rows = (j.results || [])
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id,
      name: cleanPlaceName(r.name),
      rawName: String(r.name).trim(),
      display: String(r.display_name || r.name).trim(),
      kind: placeKindLabel(r),
      adminLevel: Number.isFinite(r.admin_level) ? r.admin_level : 999,
    }));
  rows.sort((a, b) => a.adminLevel - b.adminLevel);
  const out = rows.slice(0, limit);
  // 只缓存有结果的；空结果下次重新问，免得接口一时抽风就永久记成「没有」
  if (out.length) placeCache.set(key.toLowerCase(), out);
  return out;
}

module.exports = {
  LOCALE,
  PLACES,
  CONTINENTS,
  DEFAULT_CODE,
  placeOf,
  placeIdOf,
  placeNameOf,
  resolvePlace,
  genusOf,
  buildUrl,
  resolveTaxa,
  searchPlaces,
  placeKindLabel,
  cleanPlaceName,
};
