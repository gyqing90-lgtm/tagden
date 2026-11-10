'use strict';
/**
 * 照片评分（内置版）—— 服务端存储层。
 *
 * 评分计算全在浏览器 Web Worker 里做（Node 没有 JPEG 解码器，也不许引第三方依赖），
 * 这里只负责：
 *   1. 按目录持久化评分结果，和 bio-image 评分器的 `.photo_scores.json` 互通；
 *   2. 批内百分位定星级（口径与 public/score-engine.js 的 batchStar 是同一份代码）；
 *   3. 连拍分组（EXIF 时间窗 + 感知哈希并查集）；
 *   4. AI 设置：云端 Key 用 secure.seal 加密，绝不回明文给浏览器。
 *
 * 缓存放 CACHE/score/，不写用户照片目录 —— E: 是 USB 机械盘，少一次冷写是一次。
 * 唯一的例外是「一次性导入」评分器留下的 .photo_scores.json（只读）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secure = require('./secure');
const EX = require('./exif');
const ENGINE = require('../public/score-engine.js');

let DATA = '';
let CACHE = '';
let SCORE_DIR = '';
let AI_FILE = '';

function init(opt) {
  DATA = opt.dataDir;
  CACHE = opt.cacheDir;
  SCORE_DIR = path.join(CACHE, 'score');
  AI_FILE = path.join(DATA, 'score-ai.json');
  try { fs.mkdirSync(SCORE_DIR, { recursive: true }); } catch { /* 只读缓存盘就算了 */ }
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const isImage = (n) => IMAGE_EXT.has(path.extname(n).toLowerCase());

/** 目录 → 缓存文件名：用哈希，避免中文/盘符/冒号进文件名 */
function cacheFile(dir) {
  const key = crypto.createHash('sha256').update(String(dir).toLowerCase()).digest('hex').slice(0, 24);
  return path.join(SCORE_DIR, `${key}.json`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/**
 * 读一个目录的评分。第一次会从评分器的 .photo_scores.json 导入，
 * SV=2 的历史记录直接可用，不用重评、也不会被误标 stale。
 */
function load(dir) {
  const cf = cacheFile(dir);
  let data = readJson(cf, null);
  if (data && data.dir === dir && data.scores) return data;

  const legacy = path.join(dir, '.photo_scores.json');
  const old = readJson(legacy, null);
  const scores = {};
  if (old && typeof old === 'object') {
    for (const [name, rec] of Object.entries(old)) {
      if (rec && typeof rec === 'object' && typeof rec.total === 'number') {
        scores[name] = { ...rec };
      }
    }
  }
  data = { dir, updated: 0, scores, importedFrom: Object.keys(scores).length ? legacy : '' };
  if (Object.keys(scores).length) writeJson(cf, data);
  return data;
}

function save(dir, data) {
  data.dir = dir;
  data.updated = Date.now();
  writeJson(cacheFile(dir), data);
  return data;
}

/** 列出目录里仍在的图片（不 stat 全目录，避免 USB 盘寻道风暴） */
function listImages(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && isImage(n));
  } catch { return []; }
}

/**
 * 综合分：技术分 ×0.55 + AI 分 ×0.45（1 位小数），口径照抄老评分器 app.py 的 final_score()。
 * 没有 AI 结果就没有综合分 —— 不用技术分冒充，界面上会退回显示技术分。
 */
function finalOf(total, aiScore) {
  const t = Number(total); const a = Number(aiScore);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return null;
  return Math.round((t * 0.55 + a * 0.45) * 10) / 10;
}

/** 合并一批评分结果 → 重算综合分 → 重算批内星级 → 落盘 */
function put(dir, entries) {
  const data = load(dir);
  const names = new Set(listImages(dir));
  for (const [name, rec] of Object.entries(entries || {})) {
    if (!names.has(name)) continue;
    if (!rec || typeof rec !== 'object') continue;
    const prev = data.scores[name] || {};
    const merged = { ...prev, ...rec, sv: ENGINE.SV };
    // AI 结果单独存，别被技术评分覆盖
    if (rec.ai !== undefined) merged.ai = rec.ai;
    // 综合分在这里统一算：技术评分与 AI 判别都会走 put，两条路径口径不会漂
    const fin = merged.ai && merged.ai.score !== undefined && merged.total !== undefined
      ? finalOf(merged.total, merged.ai.score) : null;
    if (fin === null) delete merged.final;
    else merged.final = fin;
    data.scores[name] = merged;
  }
  applyStars(data, dir);
  save(dir, data);
  return data;
}

function applyStars(data, dir) {
  const names = new Set(listImages(dir));
  // 清掉已删文件的记录，免得星级被幽灵占名额
  for (const n of Object.keys(data.scores)) if (!names.has(n)) delete data.scores[n];
  return ENGINE.batchStar(data.scores, (n) => names.has(n));
}

/**
 * 清评分记录。
 * - 不给 names：整个目录的记录全删（连缓存文件一起删）
 * - 给了 names：只删这几张，星级要重算（星级是批内百分位，少一张其余会变）
 */
function clear(dir, names) {
  const cf = cacheFile(dir);
  const list = Array.isArray(names) ? names.map(String).filter(Boolean) : null;
  if (!list || !list.length) {
    try { fs.unlinkSync(cf); } catch { /* 本来就没有 */ }
    return { ok: true, cleared: 0 };
  }
  const data = load(dir);
  let n = 0;
  for (const nm of list) {
    if (data.scores[nm]) { delete data.scores[nm]; n += 1; }
  }
  if (!Object.keys(data.scores).length) {
    try { fs.unlinkSync(cf); } catch { /* 本来就没有 */ }
    return { ok: true, cleared: n };
  }
  if (n) { applyStars(data, dir); save(dir, data); }
  return { ok: true, cleared: n };
}

/** 只保留还存在的图片，返回给前端；顺带算星级分布 */
function view(dir) {
  const data = load(dir);
  const names = new Set(listImages(dir));
  const scores = {};
  let changed = false;
  for (const [n, rec] of Object.entries(data.scores)) {
    if (!names.has(n)) { changed = true; continue; }
    scores[n] = rec;
  }
  if (changed) { data.scores = scores; applyStars(data, dir); save(dir, data); }
  else if (Object.keys(data.scores).length && scores[Object.keys(scores)[0]]?.star === undefined) {
    applyStars(data, dir); save(dir, data);
  }
  const counts = [0, 0, 0, 0];
  let invalid = 0;
  for (const rec of Object.values(scores)) {
    if (rec.invalid) invalid += 1;
    counts[Math.max(0, Math.min(3, rec.star || 0))] += 1;
  }
  return { ok: true, dir, updated: data.updated, scores, counts, invalid, total: Object.keys(scores).length };
}

/** 单张图的元信息：ISO（高感补偿）、拍摄时间（连拍分组）、体积 */
function fileMeta(full) {
  let iso = null;
  let time = '';
  let sizeKb = 0;
  try {
    const st = fs.statSync(full);
    sizeKb = Math.round(st.size / 1024);
    time = new Date(st.mtimeMs).toISOString().slice(0, 19);
  } catch { /* 文件刚被删 */ }
  try {
    const m = EX.meta(full);
    if (m && m.dateTime) time = m.dateTime;
    // lib/exif.js 没解析 ISO 标签，这里单独从 EXIF 头里找 0x8827
    if (!iso) iso = readIso(full);
  } catch { /* 无 EXIF 很正常 */ }
  return { iso, time, sizeKb };
}

/** 轻量 ISO 读取：只扫 EXIF APP1 的 IFD0 与 ExifIFD，不整读大图 */
function readIso(filePath) {
  try {
    const r = EX.fromBuffer(fs.readFileSync(filePath).subarray(0, 262144));
    if (r && r.iso) return r.iso;
  } catch { /* ignore */ }
  return null;
}

/**
 * 连拍分组：EXIF 时间窗内按感知哈希并查集聚类。
 * scores 里带 hash（worker 评分时顺手算的），没有 hash 的图单独成组。
 */
function bursts(dir, gapSec) {
  const data = load(dir);
  const names = listImages(dir).sort();
  const gap = Math.max(1, Math.min(600, Number(gapSec) || 3));
  const meta = {};
  for (const n of names) {
    const full = path.join(dir, n);
    const m = fileMeta(full);
    meta[n] = { t: m.time, hash: (data.scores[n] || {}).hash || null, star: (data.scores[n] || {}).star };
  }
  const items = names.slice().sort((a, b) => String(meta[a].t).localeCompare(String(meta[b].t)));
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const ms = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (ms(meta[items[j]].t) - ms(meta[items[i]].t) > gap * 1000) break;
      if (ENGINE.similarPair(meta[items[i]].hash, meta[items[j]].hash)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(items[i]);
  }
  const clusters = [];
  for (const files of groups.values()) {
    if (files.length < 2) continue;
    // 封面 = 星级最高的那张；同星看总分
    const cover = files.slice().sort((a, b) => {
      const ra = data.scores[a] || {}; const rb = data.scores[b] || {};
      return (rb.star || 0) - (ra.star || 0) || (rb.total || 0) - (ra.total || 0);
    })[0];
    clusters.push({ files, cover });
  }
  return { ok: true, dir, gap, clusters, scored: Object.keys(data.scores).length };
}

/* ---------------- AI 设置（云端 Key 加密落盘，绝不回明文） ---------------- */

const AI_DEFAULT = {
  engine: 'off',                 // off | cloud | local
  cloud: {
    model: 'qwen3-vl-plus',
    imgSide: 768,
    batch: 4,
    taxon: '昆虫',
    strict: false,
  },
  local: {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: '',                   // llama-server 加载的那个 GGUF 的别名（内置运行库启动后自动填 tagden-ai）
    modelPath: '',               // 用户选的 .gguf 主模型
    mmprojPath: '',              // 视觉投影（VLM 必需）
    ctx: 8192,
    ngl: 99,
    imgSide: 512,
    batch: 1,
    taxon: '昆虫',
    strict: false,               // （进阶）专用昆虫检测：只对昆虫类群生效
  },
};

function aiRaw() {
  const obj = readJson(AI_FILE, null);
  if (!obj) return { ...AI_DEFAULT, key: '' };
  let key = '';
  if (obj.keyEnc) {
    try {
      const opened = secure.open(obj.keyEnc);
      if (opened.ok) key = String(opened.value || '');
    } catch { /* 换了机器/用户，密文解不开就当没配 */ }
  }
  const { keyEnc, ...rest } = obj;
  void keyEnc;
  return {
    ...AI_DEFAULT,
    ...rest,
    cloud: { ...AI_DEFAULT.cloud, ...(rest.cloud || {}) },
    local: { ...AI_DEFAULT.local, ...(rest.local || {}) },
    key,
  };
}

function aiSave(obj) {
  const { key, ...rest } = obj;
  const out = { ...rest };
  if (key) {
    const sealed = secure.seal(key);
    out.keyEnc = typeof sealed === 'string' ? sealed : sealed.value || sealed.cipher || '';
  } else {
    delete out.keyEnc;
  }
  writeJson(AI_FILE, out);
}

/** 给前端：结构全给，明文 Key 只给 hasCloudKey */
function aiPublic() {
  const cfg = aiRaw();
  const { key, ...pub } = cfg;
  return { ...pub, hasCloudKey: !!key };
}

/* ---------------- 自然在线相册照片的评分（按 photoId，不进本机目录星级） ---------------- */

function remoteFile() { return path.join(SCORE_DIR, 'remote.json'); }

function remoteGet() { return readJson(remoteFile(), {}); }

function remotePut(key, item) {
  const all = remoteGet();
  all[key] = { ...item, at: Date.now() };
  writeJson(remoteFile(), all);
  return all[key];
}

/** 清掉指定 photoId 的评分；keys 为空 = 全部清空（评分页「清除评分」用） */
function remoteClear(keys) {
  const all = remoteGet();
  const list = Array.isArray(keys) ? keys.map(String).filter(Boolean) : [];
  if (!list.length) {
    writeJson(remoteFile(), {});
    return Object.keys(all).length;
  }
  let n = 0;
  for (const k of list) if (Object.prototype.hasOwnProperty.call(all, k)) { delete all[k]; n += 1; }
  writeJson(remoteFile(), all);
  return n;
}

function aiSet(patch) {
  const cur = aiRaw();
  const next = {
    ...cur,
    engine: ['off', 'cloud', 'local'].includes(patch.engine) ? patch.engine : cur.engine,
    cloud: { ...cur.cloud, ...(patch.cloud || {}) },
    local: { ...cur.local, ...(patch.local || {}) },
    key: cur.key,
  };
  if (typeof patch.key === 'string') {
    const k = patch.key.trim();
    // 前端用 '__KEEP__' 表示「不改动已存的 Key」，用 '' 表示删除
    if (k === '__KEEP__') next.key = cur.key;
    else next.key = k;
  }
  aiSave(next);
  return aiPublic();
}

module.exports = {
  init, load, put, clear, view, fileMeta, bursts, finalOf,
  aiPublic, aiRaw, aiSet,
  remoteGet, remotePut, remoteClear,
  listImages, isImage,
};
