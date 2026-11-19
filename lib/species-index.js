'use strict';

/**
 * species-index.js — 跨目录的物种索引（一次建库，之后秒查）
 *
 * 解决什么问题：
 *   一次区系分析往往横跨好几年的目录，统计页每次都要把几万张图的标签重读一遍。
 *   这里把「某个根目录扫出来的结果」按根存下来，之后查「我所有调查目录合起来有多少种」
 *   只在内存里合并，几万条也就几十毫秒。
 *
 * 和 library.js 的分工：
 *   library 是**单根**索引（换根就覆盖），服务「当前这个库」的搜索、查重、相似图；
 *   这里是**多根**并存，服务「把 2024 秋 + 2025 全年 + 2026 上半年合起来出个名录」。
 *   两边共用同一次扫描结果（LIB.scan），不重复读盘。
 *
 * 索引文件：CACHE/species-index.json
 *   { version, updatedAt, roots: { "<绝对路径>": { scannedAt, items: [[rel,size,mtimeMs,cn,latin,dateMs,gps]] } } }
 * items 用定长数组而不是对象：几万条时 JSON 体积差不多小一半，读写也快。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const INDEX_FILE = 'species-index.json';

let indexPath = '';
let data = { version: VERSION, updatedAt: 0, roots: {} };
let loaded = false;
// 合并结果缓存：索引没变就不用再遍历一遍（前端会反复刷新同一个清单）
let memo = null;
let memoSig = '';

function init(opts) {
  indexPath = path.join(String((opts && opts.cacheDir) || '.'), INDEX_FILE);
  data = { version: VERSION, updatedAt: 0, roots: {} };
  loaded = false;
  memo = null;
  memoSig = '';
  load();
}

function load() {
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!j || j.version !== VERSION || !j.roots || typeof j.roots !== 'object') return;
    data = { version: VERSION, updatedAt: Number(j.updatedAt) || 0, roots: j.roots };
  } catch {
    /* 没索引或者坏了，重新建即可 */
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const tmp = `${indexPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, indexPath);
  } catch (err) {
    console.log(`  [!!] 物种索引保存失败：${err.message}`);
  }
}

function ensure() {
  if (!loaded) load();
}

function normKey(cn, latin) {
  // 学名大小写、首尾空格都不该让同一个种分成两条（从不同相机/名录抄来的写法常不一致）
  return `${String(cn || '').trim()} ${String(latin || '').trim().toLowerCase()}`;
}

/** 把 library 扫出来的一根结果并进索引（整根替换：扫描结果本身就是该根的最新全量） */
function upsert(root, items) {
  ensure();
  const abs = path.resolve(String(root || ''));
  if (!abs) throw new Error('缺少根目录');
  const rows = [];
  for (const it of items || []) {
    if (!it || (!it.cn && !it.latin)) continue; // 没名字的图进了清单也没用，白占体积
    const rel = path.relative(abs, it.path || '').split(path.sep).join('/') || it.name || '';
    rows.push([
      rel,
      Number(it.size) || 0,
      Math.round(Number(it.mtime) || 0),
      String(it.cn || '').slice(0, 120),
      String(it.latin || '').slice(0, 160),
      Math.round(Number(it.date) || 0),
      it.gps ? 1 : 0,
    ]);
  }
  data.roots[abs] = { scannedAt: Date.now(), items: rows };
  data.updatedAt = Date.now();
  save();
  return { ok: true, root: abs, count: rows.length, ...status() };
}

function remove(root) {
  ensure();
  const abs = path.resolve(String(root || ''));
  if (data.roots[abs]) {
    delete data.roots[abs];
    data.updatedAt = Date.now();
    save();
  }
  return { ok: true, ...status() };
}

function rootsInfo() {
  ensure();
  return Object.entries(data.roots).map(([root, v]) => ({
    root,
    name: path.basename(root) || root,
    scannedAt: v.scannedAt || 0,
    count: (v.items || []).length,
  })).sort((a, b) => b.scannedAt - a.scannedAt);
}

function status() {
  const roots = rootsInfo();
  const total = roots.reduce((s, r) => s + r.count, 0);
  // 物种数要合并去重，不能把各根的种数相加（同一种会在多个目录里出现）
  const sig = `${data.updatedAt}|${roots.length}|${total}`;
  if (memo && memoSig === sig) {
    return { ok: true, updatedAt: data.updatedAt, roots, total, speciesCount: memo.size, indexPath };
  }
  return { ok: true, updatedAt: data.updatedAt, roots, total, speciesCount: build().size, indexPath };
}

/**
 * 合并所有根 → speciesKey → 记录。
 * 返回 Map，internal 用；对外用 species()。
 */
function build() {
  ensure();
  const roots = rootsInfo();
  const sig = `${data.updatedAt}|${roots.length}|${roots.reduce((s, r) => s + r.count, 0)}`;
  if (memo && memoSig === sig) return memo;
  const map = new Map();
  for (const info of roots) {
    const pack = data.roots[info.root] || { items: [] };
    for (const row of pack.items || []) {
      const [, size, mtimeMs, cn, latin, dateMs, gps] = row;
      const key = normKey(cn, latin);
      let cell = map.get(key);
      if (!cell) {
        cell = { key, cn: cn || '', latin: latin || '', n: 0, gps: 0, roots: new Set(), first: 0, last: 0, size: 0 };
        map.set(key, cell);
      }
      if (!cell.cn && cn) cell.cn = cn;
      if (!cell.latin && latin) cell.latin = latin;
      cell.n += 1;
      cell.size += size || 0;
      if (gps) cell.gps += 1;
      cell.roots.add(info.name);
      const t = dateMs || mtimeMs || 0;
      if (t) {
        if (!cell.first || t < cell.first) cell.first = t;
        if (t > cell.last) cell.last = t;
      }
    }
  }
  memo = map;
  memoSig = sig;
  return map;
}

function ymd(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 全库物种清单。
 * @param {object} [opts] { q, limit, offset, sort: 'count'|'latin'|'cn' }
 */
function species(opts = {}) {
  const map = build();
  const q = String(opts.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(20000, Number(opts.limit) || 2000));
  const offset = Math.max(0, Number(opts.offset) || 0);
  let list = [...map.values()];
  if (q) list = list.filter((s) => `${s.cn} ${s.latin}`.toLowerCase().includes(q));
  const sort = String(opts.sort || 'count');
  list.sort((a, b) => {
    if (sort === 'latin') return (a.latin || a.cn).localeCompare(b.latin || b.cn, 'en');
    if (sort === 'cn') return (a.cn || a.latin).localeCompare(b.cn || b.latin, 'zh-CN');
    return b.n - a.n || (a.latin || a.cn).localeCompare(b.latin || b.cn, 'en');
  });
  const out = list.slice(offset, offset + limit).map((s) => ({
    cn: s.cn,
    latin: s.latin,
    n: s.n,
    gps: s.gps,
    roots: [...s.roots],
    first: ymd(s.first),
    last: ymd(s.last),
  }));
  return {
    ok: true,
    updatedAt: data.updatedAt,
    total: map.size,
    matched: list.length,
    offset,
    limit,
    roots: rootsInfo(),
    list: out,
  };
}

module.exports = { init, upsert, remove, status, species, rootsInfo, INDEX_FILE };
