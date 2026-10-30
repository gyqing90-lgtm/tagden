'use strict';

/**
 * 植物智 PPBC 助手：把「鉴定出来的属名」变成
 * 「这个属在某个地区（省 / 市 / 县）有多少照片」的列表页。
 *
 * 落点为什么是 /list21
 * --------------------
 * ppbc.iplant.cn/search 是高级检索页，它上面那几栏点「检索」之后跳的正是：
 *
 *   https://ppbc.iplant.cn/list21?latin=Rhododendron&pro=福建省&didian=武夷山市&sel=like
 *   └ 图片列表页                  └ 属名          └ 省名        └ 地点      └ 模糊匹配
 *
 * 页面顶部会直接写「检索 Rhododendron 福建省 武夷山市 共 … 条。」，下面是一堵照片墙，
 * 每张都带拍摄者与拍摄地，适合核对「我在本地拍到的这个属，附近别人拍到长什么样」。
 *
 * 参数是从 /Scripts/advsearch21.js 的 btnok_Click() 里读出来的：
 *   #txtlatin → latin、#txtsppro → pro、#txtspces → didian、rb1=l → sel=like
 * 「地点」那一栏原本只能手填，这里按 iNat 选的地区自动填。
 *
 * 三条实测出来的硬规矩（都踩过）
 * ------------------------------
 * 1. pro 必须是**标准全称**。传「福建」→「抱歉，没有找到与"Rhododendron 福建"相关的图片」；
 *    传「福建省」→ 共 284 条。同理内蒙古要写「内蒙古自治区」、港澳要写「香港特别行政区」，
 *    少一个字就是零结果。所以下面这张表按民政部全称写死，不要图省事用简称。
 * 2. 只给 latin 不给 pro / didian 时，服务端会 302 到属页 /gen/<属 id>（全国范围，列出该属所有种）。
 *    这正好是「不限地区」想要的行为，所以不用自己去查属 id。
 * 3. 一定要带 sel=like（见 buildUrl 的注释），否则只出「鉴定到属」的记录，看不到种名。
 *
 * didian（地点）怎么来
 * --------------------
 * 它是拍摄地的**文本模糊匹配**（LIKE），不是结构化字段。实测（Salix + 福建省，全省 832 条）：
 *   didian=武夷山 213、didian=武夷山市 213、didian=南平市武夷山市 0
 *   city=南平市 242、district=武夷山市 205、didian=武夷山国家级自然保护区 7、didian=Wuyishan 0
 * 结论：**只能填一级地名**，多级拼起来是零结果，英文也不认。
 * 所以 iNat 的「南平市武夷山市Wuyishan City」要先拆成「武夷山市」再传（见 cleanLocality）。
 *
 * 哪些地方能用 didian
 * -------------------
 * PPBC 只收中国（含港澳台）的照片。iNat 的地区 id 靠 ancestor_place_ids 判断国别：
 *   武夷山 222739 → [97395, 6903, 54517, 27869, 222739] → 含 6903(中国) 和 54517(福建)
 *   日本   6737   → [97395, 6737]                        → 不含，判为境外
 * 港澳台比较特殊，iNat 里它们是顶级地区（香港 [97395, 7613] 没有 6903），
 * 但它们在下面这张省份表里，所以「祖先链里命中省份 id」也算中国境内 —— 这条把九龙、澳门半岛也带上了。
 *
 * 已知的服务端毛病（没法绕过，手动去搜也一样）
 * --------------------------------------------
 * PPBC 会把查询词里的小写字母 s 吃掉：「Ficus」进页面变成「Ficu」、「Rosa」变成「Ro a」。
 * 试过 %73 编码、双重编码都不行（它在解码之后过滤），而大写 S 开头的不受影响（Salix 正常）。
 * 好在它用的是模糊包含匹配，去掉 s 之后绝大多数记录照样能匹配上；只是 Rosa 这种会混进
 * 含「ro a」的无关记录。这是站方的问题，不是链接拼错了，别为此去改属名。
 * didian 因为只放中文地名，碰不到这个毛病。
 *
 * 边界
 * ----
 * 它是植物库，属名要先确认是植物属 —— 同名属在两边都有（Pieris 既是粉蝶属又是马醉木属），
 * 所以这个入口只在「植物」类群下出现，别的类群一律不显示（见 public/app.js 的 ppbcOn）。
 */

const https = require('node:https');
const inat = require('./inat');

const HOST = 'https://ppbc.iplant.cn';

/**
 * iNat 的地区代码 → PPBC 认的省份全称。
 * 只放中国境内的 34 个省级行政区；其余（国家、全世界）在表里查不到，按全国范围打开。
 */
const PROVINCE_BY_CODE = {
  'CN-11': '北京市',
  'CN-12': '天津市',
  'CN-13': '河北省',
  'CN-14': '山西省',
  'CN-15': '内蒙古自治区',
  'CN-21': '辽宁省',
  'CN-22': '吉林省',
  'CN-23': '黑龙江省',
  'CN-31': '上海市',
  'CN-32': '江苏省',
  'CN-33': '浙江省',
  'CN-34': '安徽省',
  'CN-35': '福建省',
  'CN-36': '江西省',
  'CN-37': '山东省',
  'CN-41': '河南省',
  'CN-42': '湖北省',
  'CN-43': '湖南省',
  'CN-44': '广东省',
  'CN-45': '广西壮族自治区',
  'CN-46': '海南省',
  'CN-50': '重庆市',
  'CN-51': '四川省',
  'CN-52': '贵州省',
  'CN-53': '云南省',
  'CN-54': '西藏自治区',
  'CN-61': '陕西省',
  'CN-62': '甘肃省',
  'CN-63': '青海省',
  'CN-64': '宁夏回族自治区',
  'CN-65': '新疆维吾尔自治区',
  TW: '台湾省',
  HK: '香港特别行政区',
  MO: '澳门特别行政区',
};

/** 全部省级行政区（顺序按行政区划代码，前端/文档要列的时候用） */
const PROVINCES = Object.values(PROVINCE_BY_CODE);

/** iNat 的「中国」place_id，用来判断一个自定义地区在不在国境内 */
const CN_PLACE_ID = 6903;

/**
 * iNat place_id → 省全称。反查用：拿到一个县 / 市 / 保护区，顺着祖先链找省。
 * 直接从 lib/inat.js 的 PLACES 生成，省名表只维护一份（PROVINCE_BY_CODE）。
 */
const PROVINCE_BY_PLACE_ID = {};
for (const p of inat.PLACES) {
  const full = provinceOf(p.code);
  if (full && p.placeId) PROVINCE_BY_PLACE_ID[p.placeId] = full;
}

/**
 * 地区代码 → PPBC 省名。查不到就返回空串（= 不带 pro，按全国范围打开），
 * 包括「中国」本身（CN）、境外国家、全世界。
 */
function provinceOf(code) {
  return PROVINCE_BY_CODE[String(code || '').trim().toUpperCase()] || '';
}

/** 有没有汉字。英文地名（iNat 上很多）传给 PPBC 是零结果，不如不传 */
function hasHan(s) {
  return /[\u4e00-\u9fa5]/.test(String(s || ''));
}

/** 「香港特别行政区」→「香港」、「北京市」→「北京」：用来判断地点是不是就是省本身 */
function bareProvince(pro) {
  return String(pro || '')
    .replace(/(特别行政区|自治区|自治州|省|市)$/, '')
    .replace(/(壮族|回族|维吾尔|藏族|蒙古族|傣族|苗族|彝族|布依族|侗族|哈尼族|白族)$/, '')
    .trim();
}

/**
 * iNat 地名 → PPBC 认的「一级地点」。
 *
 *   「南平市武夷山市Wuyishan City」 → 武夷山市   （去英文尾 + 取最细一级）
 *   「北京市朝阳区Chaoyang District」→ 朝阳区
 *   「西双版纳傣族自治州」            → 西双版纳傣族自治州（只有一级，原样保留）
 *   「武夷山国家级自然保护区」        → 武夷山     （去掉保护区后缀）
 *
 * 不能保留多级（「南平市武夷山市」实测零结果），也不能留英文（「Wuyishan」同样零结果）。
 */
function cleanLocality(name) {
  let s = String(name || '').trim();
  if (!s) return '';
  // 1. iNat 的中文地名常把英文粘在后面，去掉
  s = s.replace(/^([\u4e00-\u9fa5][\u4e00-\u9fa5（）()·\s]*?)([A-Za-z].*)$/, '$1').trim();
  if (!hasHan(s)) return '';
  // 2. 只留最细一级行政区（不用后行断言，老浏览器也能跑）
  const parts = s.match(/[^市县区旗盟州]*[市县区旗盟州]/g);
  if (parts && parts.length > 1) s = parts[parts.length - 1];
  // 3. 去掉保护区 / 公园一类后缀，留下地名本身（「武夷山国家级自然保护区」→「武夷山」）
  s = s
    .replace(
      /(国家级|省级|市级)?(自然保护区|保护区|国家公园|森林公园|湿地公园|地质公园|沙漠公园|风景区|景区|公园|植物园|水库|林场)$/,
      '',
    )
    .trim();
  return s;
}

/* ---------------- iNat 地区详情 ---------------- */

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
          } catch {
            reject(new Error('iNaturalist 返回内容无法解析'));
          }
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('iNaturalist 请求超时')));
    req.on('error', reject);
  });
}

const placeCache = new Map(); // place_id → { id, name, provName, inChina }

/**
 * 查一个 iNat 地区的详情，算出「在不在中国」和「属于哪个省」。
 * 结果缓存在进程内；查不到就抛错，调用方自己退回「只用名字」。
 */
async function placeInfo(placeId) {
  const id = Number(placeId) || 0;
  if (!id) return null;
  if (placeCache.has(id)) return placeCache.get(id);
  const j = await getJson(`https://api.inaturalist.org/v1/places/${id}?locale=${inat.LOCALE}`);
  const r = (j.results || [])[0];
  if (!r) throw new Error('iNaturalist 查不到这个地区');
  const chain = (Array.isArray(r.ancestor_place_ids) ? r.ancestor_place_ids : [])
    .map(Number)
    .filter(Boolean);
  if (!chain.includes(Number(r.id))) chain.push(Number(r.id));
  // 祖先链里第一个能对上省份表的就是它所在的省（港澳台本身也在表里）
  const provId = chain.find((x) => PROVINCE_BY_PLACE_ID[x]) || 0;
  const out = {
    id: Number(r.id),
    name: String(r.name || ''),
    provName: provId ? PROVINCE_BY_PLACE_ID[provId] : '',
    inChina: Boolean(provId) || chain.includes(CN_PLACE_ID),
  };
  placeCache.set(id, out);
  return out;
}

/**
 * 当前「检索地区」→ PPBC 的两个参数。
 *
 *   下拉选福建省      → { pro: '福建省', didian: '' }
 *   下拉选日本 / 中国 → { pro: '', didian: '' }（植物智只收中国照片，按全国打开）
 *   自定义「武夷山」  → { pro: '福建省', didian: '武夷山市' }
 *   自定义「Kyoto」   → { pro: '', didian: '' }（境外，不传给 PPBC）
 *
 * 查 iNat 失败（没网 / 限流）时退回「只用名字」：宁可按全国开，也不要拼出零结果。
 */
async function resolveRegion(input) {
  const o = input || {};
  const placeId = Number(o.placeId) || 0;
  const name = String(o.placeName || '').trim();

  if (placeId > 0) {
    let info = null;
    try {
      info = await placeInfo(placeId);
    } catch {
      info = null;
    }
    if (info && !info.inChina) {
      return { pro: '', didian: '', inChina: false, name: info.name || name, custom: true };
    }
    // iNat 对不少地名只给英文，这时候用前端传来的（用户搜的那个）中文名
    const raw = hasHan(info?.name) ? info.name : hasHan(name) ? name : info?.name || name;
    const loc = cleanLocality(raw);
    const pro = info?.provName || '';
    // 用户直接选了「福建省」这种省级地区时，地名和省名一样，没必要再叠一层
    // （香港这种也走这里：pro=香港特别行政区、loc=香港，传 didian 只是重复过滤）
    const bare = bareProvince(pro);
    const sameAsProv = Boolean(loc) && (loc === pro || loc === bare);
    const didian = sameAsProv ? '' : loc;
    return {
      pro,
      didian,
      inChina: true,
      name: inat.cleanPlaceName(raw) || name,
      custom: true,
    };
  }

  const pro = provinceOf(o.code);
  return {
    pro,
    didian: '',
    inChina: Boolean(pro) || String(o.code || '').trim().toUpperCase() === 'CN',
    name: inat.placeNameOf(o.code),
    custom: false,
  };
}

/**
 * 拼链接。
 * - 有省名：/list21?latin=<属>&pro=<省全称>&sel=like
 *   → 该省该属的照片列表，顶部写「共 N 条」，卡片上是**种名**（刺毛杜鹃 Rhododendron championiae）
 * - 再加地点：&didian=<一级地名> → 收窄到市 / 县 / 保护区
 * - 什么都没有：/list21?latin=<属>&sel=like → 服务端 302 到属页（全国范围，列出该属的所有种）
 *
 * `sel=like` 是「模糊匹配」开关（高级检索页上那个单选项 rb1=l），**不能省**：
 *   不带它 → 只回「鉴定到属」的记录，卡片上写着「杜鹃花属 Rhododendron」，一条种名都没有；
 *   带上它 → 属下的种全出来，卡片改成「刺毛杜鹃 Rhododendron championiae」。
 * 实测同一条件：Rhododendron 福建省 无 sel 284 条 / 带 sel 12960 条，差别就在这。
 */
function buildUrl({ genus, pro, didian } = {}) {
  const q = new URLSearchParams();
  q.set('latin', String(genus || '').trim());
  const p = String(pro || '').trim();
  if (p) q.set('pro', p);
  const d = String(didian || '').trim();
  if (d) q.set('didian', d);
  q.set('sel', 'like');
  return `${HOST}/list21?${q.toString()}`;
}

/** 给人看的一句话范围：「福建省 · 武夷山市」/「福建省」/「全国」 */
function scopeLabel(r) {
  const o = r || {};
  if (o.pro && o.didian) return `${o.pro} · ${o.didian}`;
  return o.pro || o.didian || '';
}

module.exports = {
  HOST,
  CN_PLACE_ID,
  PROVINCE_BY_CODE,
  PROVINCE_BY_PLACE_ID,
  PROVINCES,
  provinceOf,
  cleanLocality,
  placeInfo,
  resolveRegion,
  buildUrl,
  scopeLabel,
};
