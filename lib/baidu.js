'use strict';

/**
 * 百度智能云「图像识别」——动物识别 / 植物识别。
 *
 * 认证是 AK/SK 换 access_token（client_credentials），token 有效期 30 天，
 * 这里缓存 25 天，提前换掉；token 本身不消耗任何额度，所以「保存并登录」
 * 只换 token、不做识别，既不烧配额又能验证密钥对不对。
 *
 * 两个接口：
 *   POST /rest/2.0/image-classify/v1/animal   top_num 1~20，默认 6
 *   POST /rest/2.0/image-classify/v1/plant
 *   body: application/x-www-form-urlencoded，image = 图片 base64（< 4MB）
 *   返回: { result: [ { name: '山麻雀', score: '0.994984' } ] }
 *
 * 有个必须记住的坑：**百度只给中文名，不给拉丁学名**。
 * 所以合并表里它可能对不上别家的学名 —— 对策有两层：
 *   1) 植物接口带 baike_num=1，从百科描述里抠「学名：Rosa chinensis」；
 *   2) 剩下的按中文名在 lib/aggregate.js 里做第二遍归并。
 * 另外认不出来时它返回 name = 非动物 / 非植物（不是空数组），也要当「跳过」处理。
 */

const { SiteError } = require('./http');

const BAIDU_BASE = (process.env.BIOID_BAIDU_BASE || 'https://aip.baidubce.com').replace(/\/+$/, '');
const TOKEN_TTL = 25 * 24 * 3600 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;

const KINDS = {
  animal: { path: 'image-classify/v1/animal', label: '动物', empty: '非动物' },
  plant: { path: 'image-classify/v1/plant', label: '植物', empty: '非植物' },
};

/* 常见错误码 → 人话。识别接口和换 token 报的不是同一套，合在一张表里 */
const ERRORS = {
  1: '百度服务出了个未知错误，重试一次看看',
  2: '百度服务暂时不可用，稍后再试',
  3: '这个接口没开通，或地址不对',
  4: '请求量超过集群限额，稍等一会儿',
  6: '没有该接口的权限，去百度控制台看看应用是否勾选了「图像识别」',
  14: 'IAM 鉴权失败：检查 API Key / Secret Key 是否属于同一个应用',
  17: '今天调用量超限了（免费额度用完），明天再来或去控制台买量',
  18: '调用太频繁，超过免费版的 QPS 限制，等两秒再点',
  19: '请求总量超限，去控制台看看配额',
  110: 'access_token 无效，已自动换新再试',
  111: 'access_token 过期，已自动换新再试',
  216100: '请求参数不合法',
  216101: '缺少参数',
  216200: '图片是空的',
  216201: '图片格式不支持（仅 jpg / png / bmp）',
  216202: '图片太大了（base64 后需小于 4MB）',
  216203: '图片边长不合要求（最短边 15px 以上）',
  282000: '百度服务内部错误，重试一次',
  282003: '缺少必填参数',
  282110: '图片格式错误',
};

/* ---------------- token 缓存 ----------------
 * 只放内存，不落盘：access_token 本身就是一张 30 天有效的凭据，
 * 写进 data/ 等于在密文配置旁边多放一份明文钥匙。
 * 重新换一张只花一次请求、不消耗识别额度，进程重启换一次完全可接受。 */
const tokenCache = new Map(); // kind → { ak, token, at }

function hashAk(ak) {
  return require('node:crypto').createHash('sha256').update(ak).digest('hex').slice(0, 16);
}

function credsOf(cfg) {
  const ak = String(cfg?.apiKey || '').trim();
  const sk = String(cfg?.secretKey || '').trim();
  if (!ak || !sk) throw new SiteError('百度：还没填 API Key / Secret Key', { status: 401 });
  return { ak, sk };
}

async function tokenOf(cfg, kind, force = false) {
  const { ak, sk } = credsOf(cfg);
  const hit = tokenCache.get(kind);
  // 换过 key 就作废旧 token；同理过期也重换
  if (!force && hit && hit.ak === hashAk(ak) && Date.now() - hit.at < TOKEN_TTL) return hit.token;

  const url =
    `${BAIDU_BASE}/oauth/2.0/token?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(ak)}&client_secret=${encodeURIComponent(sk)}`;
  let json;
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000) });
    json = await res.json();
  } catch (err) {
    throw new SiteError(`连不上百度（${err.message || err}）`, { status: 0 });
  }
  if (!json.access_token) {
    const code = String(json.error || json.error_description || '');
    const msg = /invalid_client|invalid_client_id/i.test(code)
      ? '百度说密钥不对：确认 API Key 与 Secret Key 是同一个应用的'
      : `百度换 token 失败：${json.error_description || json.error || '未知原因'}`;
    throw new SiteError(msg, { status: 401 });
  }
  tokenCache.set(kind, { ak: hashAk(ak), token: json.access_token, at: Date.now() });
  return json.access_token;
}

/* ---------------- 识别 ---------------- */

function errText(json) {
  const code = Number(json.error_code);
  const known = ERRORS[code];
  const detail = String(json.error_msg || '').trim();
  return known ? `${known}${detail && !known.includes(detail) ? `（${detail}）` : ''}` : `百度报错 ${code}：${detail || '未知原因'}`;
}

/** 从百科描述里抠学名：「月季花（学名：Rosa chinensis Jacq.）是…」→ Rosa chinensis */
function sciNameOf(item) {
  const desc = String(item?.baike_info?.description || '');
  const m = desc.match(/学名[：:]\s*([A-Z][a-zA-Z]+(?:\s+[a-z][a-z-]*){0,2})/);
  if (!m) return '';
  // 只取属名 + 种加词，丢掉命名人（Jacq. / L. 之类）
  return m[1].trim().split(/\s+/).slice(0, 2).join(' ');
}

async function identify(kind, cfg, img) {
  const meta = KINDS[kind];
  if (!meta) throw new SiteError('未知的百度识别类型');
  const buffer = img.jpeg || img.buffer;
  if (!buffer) throw new SiteError('未拿到图片数据');
  if (buffer.length > MAX_BYTES) {
    throw new SiteError('百度只收 4MB 以内的图，请先压缩', { status: 400 });
  }

  const params = new URLSearchParams({ image: buffer.toString('base64') });
  if (kind === 'animal') {
    params.set('top_num', '5');
  } else {
    // 植物接口没有 top_num；baike_num=1 才会带「学名」，用来跟别家对齐
    params.set('baike_num', '1');
  }

  const call = async (token) => {
    let res;
    try {
      res = await fetch(`${BAIDU_BASE}/rest/2.0/${meta.path}?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      const msg = /timeout|aborted/i.test(err.message || '') ? '百度识别超时' : '连不上百度';
      throw new SiteError(`${msg}（${err.message || err}）`, { status: 0 });
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new SiteError(`百度返回了非 JSON 内容（HTTP ${res.status}）`, { status: 502 });
    }
  };

  let token = await tokenOf(cfg, kind);
  let json = await call(token);
  // 110/111 = token 无效/过期：换一次再试，换完还错就报出去
  if (Number(json.error_code) === 110 || Number(json.error_code) === 111) {
    token = await tokenOf(cfg, kind, true);
    json = await call(token);
  }
  if (json.error_code) {
    const code = Number(json.error_code);
    throw new SiteError(errText(json), { status: code === 17 || code === 18 || code === 19 ? 429 : 400 });
  }

  const list = Array.isArray(json.result) ? json.result : [];
  if (!list.length) throw new SiteError(`百度没识别出${meta.label}`, { status: 400 });
  if (list.length === 1 && String(list[0].name || '').trim() === meta.empty) {
    throw new SiteError(`百度没识别出${meta.label}：画面里可能不是${meta.label}`, { status: 400 });
  }

  return list
    .filter((it) => it && it.name && it.name !== meta.empty)
    .map((it, i) => {
      const raw = Number(it.score);
      return {
        latin: sciNameOf(it),
        cn: String(it.name).trim(),
        score: Math.round((Number.isFinite(raw) ? raw : 0) * 1000) / 10,
        rank: i + 1,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((it, i) => ({ ...it, rank: i + 1 }));
}

/** 只验密钥：换一次 token，不识别、不烧额度 */
async function check(kind, cfg) {
  const token = await tokenOf(cfg, kind, false);
  return { ok: true, token: token.slice(0, 8) };
}

module.exports = { identify, check, KINDS };
