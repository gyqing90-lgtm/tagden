'use strict';
/**
 * stats-cache.js — 统计快照缓存（按 文件大小 + mtime 失效）
 *
 * 统计页原来每次都要把整个文件夹的照片读一遍标签和 EXIF：5000 张就要几十秒，
 * 上万张能拖到几分钟，可绝大多数图自上次统计后根本没变过。
 *
 * 这里把「每张图读出来的结果」按相对路径存成快照，下次进来先用 stat 比
 * size + mtimeMs，一致就直接复用，不开文件、不解析 EXIF。
 *
 * 与 lib/library.js（图库索引）同一思路：
 *   - 都落在 CACHE/ 下，纯 JSON，随时可删，删了下次自动重建；
 *   - 键都是「路径 + size + mtime」，改过就失效，不需要用户手动刷新；
 *   - 坏了/版本不符就当没有，不影响主流程。
 *
 * 「多个目录汇总统计」会同时开好几个根，所以每个 open() 返回**独立的句柄**
 * （各自的 rootKey / seen / hits / misses），落盘仍然是同一个 JSON 文件。
 *
 * 一张图约 90 字节，1 万张 ≈ 0.9 MB，比 library.json 小得多。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const FILE = 'stats-cache.json';
/** 换过多少个文件夹就丢最老的，避免缓存文件无限长 */
const MAX_ROOTS = 6;

let cachePath = '';
let db = { version: VERSION, roots: {} };
let loaded = false;

function load() {
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!j || j.version !== VERSION || !j.roots || typeof j.roots !== 'object') return;
    db = { version: VERSION, roots: j.roots };
  } catch {
    /* 没缓存/坏了：当成空的，重扫一次即可 */
  }
}

function trim() {
  const keys = Object.keys(db.roots);
  if (keys.length <= MAX_ROOTS) return;
  keys
    .sort((a, b) => (db.roots[a].savedAt || 0) - (db.roots[b].savedAt || 0))
    .slice(0, keys.length - MAX_ROOTS)
    .forEach((k) => delete db.roots[k]);
}

/**
 * 打开某个文件夹的缓存句柄。
 * @param {string} cacheDir CACHE 目录
 * @param {string} root     统计的根目录（绝对路径）
 */
function open(cacheDir, root) {
  cachePath = path.join(String(cacheDir || '.'), FILE);
  if (!loaded) load();
  const rootKey = path.resolve(root);
  if (!db.roots[rootKey] || typeof db.roots[rootKey].files !== 'object') {
    db.roots[rootKey] = { savedAt: 0, files: {} };
  }
  const seen = new Set();
  const stat = { hits: 0, misses: 0 };

  /** 条目格式（数组比对象省一半体积）：[size, mtimeMs, cn, latin, dateTime, lat, lon, make, model, takenMs, takenSrc] */
  function get(rel, st) {
    if (!st) return null;
    const files = db.roots[rootKey] && db.roots[rootKey].files;
    const e = files && files[rel];
    if (!e) {
      stat.misses += 1;
      return null;
    }
    // 尺寸或修改时间变了 → 这张图被动过（重存/替换/改名），必须重读
    if (e[0] !== st.size || Math.round(e[1]) !== Math.round(st.mtimeMs)) {
      stat.misses += 1;
      return null;
    }
    seen.add(rel);
    stat.hits += 1;
    return {
      cn: e[2] || '',
      latin: e[3] || '',
      ex: {
        dateTime: e[4] || '',
        lat: e[5] == null ? null : e[5],
        lon: e[6] == null ? null : e[6],
        make: e[7] || '',
        model: e[8] || '',
      },
      taken: e[9] ? new Date(e[9]) : null,
      takenSrc: e[10] || '',
    };
  }

  function put(rel, st, item) {
    if (!st) return;
    const files = db.roots[rootKey].files;
    const ex = (item && item.ex) || {};
    const taken = item && item.taken instanceof Date ? item.taken.getTime() : null;
    files[rel] = [
      st.size,
      Math.round(st.mtimeMs),
      (item && item.cn) || '',
      (item && item.latin) || '',
      ex.dateTime || '',
      ex.lat == null ? null : ex.lat,
      ex.lon == null ? null : ex.lon,
      ex.make || '',
      ex.model || '',
      taken,
      (item && item.takenSrc) || '',
    ];
    seen.add(rel);
  }

  /** 落盘：顺带把已删除/移走的文件从快照里清掉 */
  function save() {
    try {
      const rec = db.roots[rootKey];
      if (!rec) return { ok: false };
      const files = rec.files;
      let dropped = 0;
      for (const rel of Object.keys(files)) {
        if (!seen.has(rel)) {
          delete files[rel];
          dropped += 1;
        }
      }
      rec.savedAt = Date.now();
      trim();
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmp, JSON.stringify(db), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, cachePath);
      return { ok: true, entries: Object.keys(files).length, dropped };
    } catch (err) {
      console.log(`  [i] 统计快照保存失败（不影响本次结果）：${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** 给状态页/诊断包用：只报数字，不暴露内容 */
  function status() {
    const rec = db.roots[rootKey] || { savedAt: 0, files: {} };
    return {
      ok: true,
      root: rootKey,
      entries: Object.keys(rec.files || {}).length,
      savedAt: Number(rec.savedAt) || 0,
      hits: stat.hits,
      misses: stat.misses,
      cachePath,
    };
  }

  return { root: rootKey, get, put, save, status };
}

/** 全局状态（诊断用）：一共缓存了几个根、占多大 */
function globalStatus() {
  if (!loaded) load();
  const roots = Object.keys(db.roots);
  let entries = 0;
  for (const r of roots) entries += Object.keys(db.roots[r].files || {}).length;
  return { roots: roots.length, entries, cachePath };
}

module.exports = { open, globalStatus };
