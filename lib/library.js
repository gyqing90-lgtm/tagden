'use strict';
/**
 * library.js — 本地图库索引（全库搜索 / 重复文件）
 *
 * 索引落在 CACHE/library.json，不进 data/，随时可重建：
 *   { version, root, scannedAt, total, items: [{path,dir,name,folder,size,mtime,
 *     cn,latin,date,gps,sha256}] }
 *
 * 只索引元数据，不复制图片；搜索和重复检测都在本机完成，不联网。
 * 重复文件先按 size 分组，只对同尺寸的候选算 SHA-256，避免全库读一遍。
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const IMG = require('./imgmeta');

const VERSION = 1;
const MAX_FILES = 50000;
const MAX_DEPTH = 16;
const INDEX_FILE = 'library.json';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff', '.bmp', '.gif']);
const SKIP_DIRS = new Set([
  '.git', '.svn', '.cache', 'node_modules', '$RECYCLE.BIN', 'System Volume Information',
  '@eaDir', '.thumbnails', '.Trash', '.Trashes', 'dist', 'dist-mac', '.build', '.build-tools',
]);

let indexPath = '';
let data = { version: VERSION, root: '', scannedAt: 0, total: 0, items: [] };
let loaded = false;

function init(opts) {
  indexPath = path.join(String((opts && opts.cacheDir) || '.'), INDEX_FILE);
  data = { version: VERSION, root: '', scannedAt: 0, total: 0, items: [] };
  loaded = false;
  load();
}

function load() {
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!j || j.version !== VERSION || !Array.isArray(j.items)) return;
    data = {
      version: VERSION,
      root: String(j.root || ''),
      scannedAt: Number(j.scannedAt) || 0,
      total: j.items.length,
      items: j.items,
    };
  } catch {
    /* 没索引/坏了就空着，重新扫一次即可 */
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const tmp = `${indexPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, indexPath);
  } catch (err) {
    console.log(`  [!!] 图库索引保存失败：${err.message}`);
  }
}

function status() {
  if (!loaded) load();
  return {
    ok: true,
    root: data.root,
    scannedAt: data.scannedAt,
    total: data.total,
    hasIndex: Boolean(data.root && data.scannedAt),
    indexPath,
  };
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function looksLatin(s) {
  return /^[A-Z][a-z]{2,}\s+[a-z][a-z-]{1,}/.test(String(s || '').trim());
}

function splitLabel(label) {
  const kws = Array.isArray(label && label.kw) ? label.kw.map((x) => String(x).trim()).filter(Boolean) : [];
  let latin = kws.find(looksLatin) || '';
  let cn = kws.find((x) => !looksLatin(x)) || '';
  const title = String((label && label.title) || '').trim();
  if (!latin && looksLatin(title)) latin = title;
  if (!cn && title && !looksLatin(title)) cn = title;
  return { cn, latin };
}

function splitName(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const latin = (base.match(/[A-Z][a-z]{2,}\s+[a-z][a-z-]{1,}/) || [''])[0];
  const cn = (base.match(/[\u4e00-\u9fa5·]{2,}/) || [''])[0];
  return { cn, latin };
}

function takenMs(meta, mtimeMs) {
  if (meta && meta.dateTime) {
    const d = new Date(String(meta.dateTime).replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return Number(mtimeMs) || 0;
}

async function walk(root, onProgress, isCancelled) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (isCancelled && isCancelled()) throw new Error('已取消');
    const cur = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (files.length >= MAX_FILES) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || cur.depth >= MAX_DEPTH) continue;
        stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(full);
      }
    }
    if (onProgress) onProgress({ phase: 'walk', done: files.length, total: 0, current: cur.dir });
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

async function mapLimit(list, limit, fn, isCancelled) {
  const arr = Array.from(list);
  const out = new Array(arr.length);
  let next = 0;
  const workers = Math.max(1, Math.min(Number(limit) || 1, arr.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        if (isCancelled && isCancelled()) throw new Error('已取消');
        const i = next++;
        if (i >= arr.length) return;
        out[i] = await fn(arr[i], i);
      }
    }),
  );
  return out;
}

async function scan(root, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : null;
  const abs = path.resolve(String(root || ''));
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error('不是一个文件夹');
  const files = await walk(abs, onProgress, isCancelled);
  let done = 0;
  const items = await mapLimit(
    files,
    8,
    async (full) => {
      let label = null;
      let meta = null;
      let size = 0;
      let mtime = 0;
      try {
        const s = await fsp.stat(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        return null;
      }
      try {
        label = await IMG.readLabelFastAsync(full, { withMeta: true });
        meta = label && label.meta ? label.meta : null;
      } catch {
        label = null;
      }
      const fromLabel = splitLabel(label);
      const fromName = splitName(path.basename(full));
      const cn = fromLabel.cn || fromName.cn;
      const latin = fromLabel.latin || fromName.latin;
      const rel = path.relative(abs, full).split(path.sep).join('/');
      const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '根目录';
      done += 1;
      if (onProgress) onProgress({ phase: 'read', done, total: files.length, current: rel });
      return {
        path: full,
        dir: path.dirname(full),
        name: path.basename(full),
        folder,
        size,
        mtime,
        cn: String(cn || '').slice(0, 120),
        latin: String(latin || '').slice(0, 160),
        date: takenMs(meta, mtime),
        gps: Boolean(meta && meta.lat != null && meta.lon != null),
        sha256: '',
      };
    },
    isCancelled,
  );
  data = {
    version: VERSION,
    root: abs,
    scannedAt: Date.now(),
    total: items.filter(Boolean).length,
    items: items.filter(Boolean),
  };
  save();
  return status();
}

function search(opts = {}) {
  if (!loaded) load();
  const q = norm(opts.q);
  const filter = String(opts.filter || 'all');
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 120));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const all = (data.items || []).filter((it) => {
    if (filter === 'latin' && !it.latin) return false;
    if (filter === 'nolatin' && it.latin) return false;
    if (filter === 'gps' && !it.gps) return false;
    if (!q) return true;
    return [it.name, it.path, it.folder, it.cn, it.latin].some((x) => norm(x).includes(q));
  });
  all.sort((a, b) => (b.date || 0) - (a.date || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return {
    ok: true,
    root: data.root,
    scannedAt: data.scannedAt,
    total: all.length,
    offset,
    limit,
    items: all.slice(offset, offset + limit),
  };
}

function hashFile(file, isCancelled) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (buf) => {
      if (isCancelled && isCancelled()) {
        rs.destroy();
        reject(new Error('已取消'));
        return;
      }
      h.update(buf);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

async function duplicates(opts = {}) {
  if (!loaded) load();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : null;
  const bySize = new Map();
  for (const it of data.items || []) {
    if (!it || !it.size) continue;
    const arr = bySize.get(it.size) || [];
    arr.push(it);
    bySize.set(it.size, arr);
  }
  const cand = [];
  for (const arr of bySize.values()) if (arr.length > 1) for (const it of arr) cand.push(it);
  const limit = 5000;
  const use = cand.slice(0, limit);
  let done = 0;
  await mapLimit(
    use,
    4,
    async (it) => {
      if (!it.sha256) {
        try {
          it.sha256 = await hashFile(it.path, isCancelled);
        } catch {
          it.sha256 = '';
        }
      }
      done += 1;
      if (onProgress) onProgress({ phase: 'hash', done, total: use.length, current: it.name });
    },
    isCancelled,
  );
  const groups = new Map();
  for (const it of use) {
    if (!it.sha256) continue;
    const k = `${it.size}:${it.sha256}`;
    const arr = groups.get(k) || [];
    arr.push(it);
    groups.set(k, arr);
  }
  if (use.length) save();
  const out = [...groups.values()]
    .filter((arr) => arr.length > 1)
    .map((arr) => ({
      size: arr[0].size,
      sha256: arr[0].sha256,
      wasted: (arr[0].size || 0) * (arr.length - 1),
      items: arr.map((it) => ({
        path: it.path, dir: it.dir, name: it.name, folder: it.folder,
        cn: it.cn, latin: it.latin, size: it.size, date: it.date,
      })),
    }))
    .sort((a, b) => b.wasted - a.wasted);
  return { ok: true, groups: out, candidates: cand.length, hashed: use.length, truncated: cand.length > limit };
}

module.exports = { init, status, scan, search, duplicates };
