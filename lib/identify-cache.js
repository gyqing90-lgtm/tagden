'use strict';

/**
 * 识别结果缓存 —— 同一张图 + 同一组站点，一段时间内直接回上一次的合并结果。
 *
 * 为什么要它：多识 / 豆包 / 快瞳 / 懂鸟都按次计费，同一张图反复点「识别选中」
 * 等于重复烧额度；而且每轮要等各站 5～30 秒。缓存键用浏览器压好的 640px 预览图
 * （写标签只改元数据、不改像素），标注完再识别仍能命中。
 *
 * 设计取舍：
 *   - 只缓存「至少有一个站点给出结果」的响应；全失败不缓存，避免把网络抖动锁住。
 *   - 有站点失败的结果只留 7 天，全部成功留 30 天。
 *   - 一个结果一个 JSON 文件，按内容哈希命名；启动 7 秒后清一次过期/超量。
 *   - 键里带名录版本和 CACHE_VERSION：合并逻辑或大陆名数据变了，旧缓存自动失效。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TTL = 30 * 24 * 3600 * 1000;
const PARTIAL_TTL = 7 * 24 * 3600 * 1000;
const MAX = 5000;
const VERSION = 'v1';

let dir = '';
let max = MAX;

function init(opt = {}) {
  dir = String(opt.dir || '');
  max = Number(opt.max) || MAX;
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 只读缓存盘就算了 */ }
  }
}

function fileFor(key) {
  return path.join(dir, `${key}.json`);
}

/**
 * @param {{small?: Buffer, buffer?: Buffer}} img
 * @param {string[]} keys 真正要请求的站点 key（已做同站去重）
 * @param {string|number} [dataVersion] 名录等会影响结果的版本号
 */
function keyFor(img, keys, dataVersion = '') {
  const basis = (img && (img.small || img.buffer)) || null;
  if (!basis) throw new Error('识别缓存缺少图片数据');
  const h = crypto.createHash('sha256');
  h.update(basis);
  h.update(`|${VERSION}|`);
  h.update((Array.isArray(keys) ? keys.slice().sort() : []).join(','));
  h.update('|');
  h.update(String(dataVersion || ''));
  return h.digest('hex').slice(0, 32);
}

function read(key) {
  if (!dir || !key) return null;
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    if (!j || !j.result || !j.at) return null;
    if (Date.now() - Number(j.at) > (Number(j.ttl) || TTL)) return null;
    return j.result;
  } catch {
    return null;
  }
}

function write(key, result, ttl = TTL) {
  if (!dir || !key || !result) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(key);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), ttl, result }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 删掉过期和超量的缓存，返回删除条数。启动后延迟跑，不挡首屏。 */
function prune(limit = max) {
  if (!dir) return 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      rows.push({ file, at: st.mtimeMs });
    } catch {
      /* 刚被删掉 */
    }
  }
  const keep = rows
    .filter((r) => now - r.at <= TTL)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Number(limit) || max));
  const keepSet = new Set(keep.map((r) => r.file));
  let removed = 0;
  for (const r of rows) {
    if (keepSet.has(r.file)) continue;
    try {
      fs.unlinkSync(r.file);
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

module.exports = { init, keyFor, read, write, prune, TTL, PARTIAL_TTL, MAX };
