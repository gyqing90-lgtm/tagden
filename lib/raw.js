'use strict';
/**
 * raw.js — 相机 RAW 的「借壳」支持
 *
 * 不解 RAW 像素（那要 libraw/dcraw，几十 MB 原生依赖，和「单文件 exe」冲突），
 * 只做一件事：把 RAW 里**内嵌的 JPEG 预览图**掏出来。
 *
 * 为什么够用：几乎每张 RAW 都至少带一张 JPEG —— 相机为了让你在机背屏幕上回看，
 * 会存一张全尺寸（或 1/2 尺寸）JPEG，外加一张 160×120 的小缩略图。这张图的
 * 曝光、构图、EXIF 和后期处理的成品几乎一致，拿它做缩略图、预览、识别、评分
 * 都成立，成本只有解析几个 TIFF 标签。
 *
 * 三种容器的取法：
 *   - TIFF 系（.nef/.cr2/.arw/.dng/.pef/.srw/.rw2/.orf）：IFD 里直接有
 *     JPEGInterchangeFormat(0x0201) + JPEGInterchangeFormatLength(0x0202)，
 *     或者在 SubIFDs(0x014A) / IFD1 里；StripOffsets(0x0111) 也常被拿来存预览。
 *   - CR3 / RAF 之类：结构不是标准 TIFF，退化成「在文件里找 SOI…EOI」。
 *   - 都没有：返回 null，调用方回退到「这张图看不了」。
 *
 * 抽出来的 JPEG 按「路径 + 大小 + 修改时间」缓存到 CACHE/raw/，
 * 一张 2 MB 的预览只解析一次，之后直接吐文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 常见 RAW 扩展名（.tif/.dng 也有相机直接出，仍然按 TIFF 处理） */
const RAW_EXT = new Set([
  '.nef', '.nrw', // Nikon
  '.cr2', '.cr3', '.crw', // Canon
  '.arw', '.srf', '.sr2', // Sony
  '.dng', // Adobe / 手机
  '.raf', // Fuji
  '.orf', // Olympus
  '.rw2', '.raw', // Panasonic / 通用
  '.pef', // Pentax
  '.srw', // Samsung
  '.3fr', '.fff', // Hasselblad
  '.iiq', // Phase One
  '.mos', // Leaf
]);

/** IFD 最多跟几层（IFD0 → SubIFD → SubIFD…），防止畸形文件把栈打穿 */
const MAX_IFD_DEPTH = 4;
/** 一个 IFD 最多读多少项（正常几十项，超出必然是坏文件） */
const MAX_ENTRIES = 512;

let cacheDir = '';

function init(opts) {
  cacheDir = path.join(String((opts && opts.cacheDir) || '.'), 'raw');
}

function isRaw(p) {
  return RAW_EXT.has(path.extname(String(p || '')).toLowerCase());
}

const isJpeg = (b, off) => b.length >= off + 3 && b[off] === 0xff && b[off + 1] === 0xd8 && b[off + 2] === 0xff;

/**
 * 带范围读取的文件句柄：IFD 表通常在文件头部，但预览图的偏移可能落在几十 MB 处，
 * 所以不能一次把整个 RAW 读进内存（30~80 MB × 并发会顶爆堆）。
 */
function openReader(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const memo = new Map();
  return {
    size,
    read(off, len) {
      if (off < 0 || len <= 0 || off >= size) return Buffer.alloc(0);
      const n = Math.min(len, size - off);
      const key = `${off}:${n}`;
      if (memo.has(key)) return memo.get(key);
      const buf = Buffer.allocUnsafe(n);
      try {
        fs.readSync(fd, buf, 0, n, off);
      } catch {
        return Buffer.alloc(0);
      }
      if (memo.size < 64) memo.set(key, buf);
      return buf;
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch {}
    },
  };
}

/** 从 TIFF 头里收所有「可能是预览 JPEG」的 (offset,length) */
function tiffCandidates(rd) {
  const head = rd.read(0, 16);
  if (head.length < 8) return [];
  const le = head[0] === 0x49 && head[1] === 0x49; // 'II'
  if (!le && !(head[0] === 0x4d && head[1] === 0x4d)) return []; // 既不是 II 也不是 MM
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));

  const out = [];
  const seen = new Set();

  /** 取一个 tag 的数值数组：内联直接给，外置按 type 读，Strips 可能有多段 */
  const valuesOf = (tbl, at, type, count, inline, val) => {
    const sizeOf = type === 3 ? 2 : type === 4 ? 4 : 1;
    const total = count * sizeOf;
    if (inline) return [val];
    if (type !== 3 && type !== 4) return [];
    const raw = rd.read(val, Math.min(total, 64 * 1024));
    const n = Math.min(count, Math.floor(raw.length / sizeOf));
    const arr = [];
    for (let i = 0; i < n; i += 1) arr.push(sizeOf === 2 ? u16(raw, i * 2) : u32(raw, i * 4));
    return arr;
  };

  const walk = (offset, depth) => {
    if (!offset || depth > MAX_IFD_DEPTH || seen.has(offset) || offset + 2 > rd.size) return;
    seen.add(offset);
    const cntBuf = rd.read(offset, 2);
    if (cntBuf.length < 2) return;
    const count = u16(cntBuf, 0);
    if (!count || count > MAX_ENTRIES) return;
    const tableLen = 2 + count * 12 + 4;
    const tbl = rd.read(offset, tableLen);
    if (tbl.length < 2 + count * 12) return;

    const jpegStart = new Map(); // 同一次 IFD 内配对 0x0201/0x0202
    const strips = new Map(); // 0x0111 / 0x0117

    for (let i = 0; i < count; i += 1) {
      const at = 2 + i * 12;
      const tag = u16(tbl, at);
      const type = u16(tbl, at + 2);
      const n = u32(tbl, at + 4);
      // 值域：type 3 (SHORT) 且 count=1 时值内联在前 2 字节，其余按偏移读
      const inline = n * (type === 3 ? 2 : type === 4 ? 4 : 1) <= 4;
      const val = inline ? (type === 3 ? u16(tbl, at + 8) : u32(tbl, at + 8)) : u32(tbl, at + 8);

      if (tag === 0x0201 || tag === 0x0111) {
        const bag = tag === 0x0201 ? jpegStart : strips;
        const vals = valuesOf(tbl, at, type, n, inline, val);
        if (vals.length) bag.set('off', vals[0]);
      } else if (tag === 0x0202 || tag === 0x0117) {
        // 这两个的「值」才是长度（count 只是数组元素个数，通常就是 1）
        const bag = tag === 0x0202 ? jpegStart : strips;
        const vals = valuesOf(tbl, at, type, n, inline, val);
        if (vals.length) bag.set('len', vals.reduce((a, b) => a + b, 0));
      } else if (tag === 0x014a) {
        // SubIFDs：值是一串偏移
        const vals = valuesOf(tbl, at, type, n, inline, val);
        for (const o of vals.slice(0, 8)) walk(o, depth + 1);
      } else if (tag === 0x8769) {
        walk(val, depth + 1); // ExifIFD：只为了里面的缩略图（少见）
      }
    }

    for (const bag of [jpegStart, strips]) {
      const off = bag.get('off');
      const len = bag.get('len');
      if (off && len && len > 1024 && off + len <= rd.size) out.push({ offset: off, length: len });
    }

    const tail = tbl.length >= 2 + count * 12 + 4 ? u32(tbl, 2 + count * 12) : 0;
    if (tail) walk(tail, depth + 1); // IFD1：通常是缩略图
  };

  walk(u32(head, 4), 0);
  return out;
}

/** 兜底：在整个文件里找 SOI…EOI（CR3 / RAF 这类非 TIFF 容器） */
function scanCandidates(rd) {
  const out = [];
  const CHUNK = 4 * 1024 * 1024;
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const EOI = Buffer.from([0xff, 0xd9]);
  let pos = 0;
  let found = 0;
  let carry = Buffer.alloc(0);
  while (pos < rd.size && found < 12) {
    const buf = Buffer.concat([carry, rd.read(pos, CHUNK)]);
    if (!buf.length) break;
    let i = buf.indexOf(SOI);
    while (i >= 0 && found < 12) {
      const abs = pos - carry.length + i;
      // EOI 在 SOI 之后：先在本块里找，找不到就把尾部留到下一轮
      const j = buf.indexOf(EOI, i + 3);
      if (j > i) {
        out.push({ offset: abs, length: j + 2 - i });
        found += 1;
      }
      i = buf.indexOf(SOI, i + 3);
    }
    carry = buf.slice(Math.max(0, buf.length - 2));
    pos += CHUNK - 2;
    if (rd.size <= CHUNK) break;
  }
  return out;
}

/** 列出文件里可用的预览图（按字节数从大到小），只验证 SOI 头 */
function previews(filePath) {
  const rd = openReader(filePath);
  try {
    const all = [...tiffCandidates(rd), ...scanCandidates(rd)];
    const uniq = new Map();
    for (const c of all) {
      if (c.offset + c.length > rd.size) continue;
      if (c.length < 2048) continue; // 1 KB 以下必然是坏项
      if (uniq.has(c.offset)) continue;
      if (!isJpeg(rd.read(c.offset, 3), 0)) continue;
      uniq.set(c.offset, c);
    }
    return [...uniq.values()].sort((a, b) => b.length - a.length);
  } finally {
    rd.close();
  }
}

function cachePath(filePath, kind) {
  const st = fs.statSync(filePath);
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(filePath)}|${st.size}|${Math.round(st.mtimeMs)}|${kind}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return path.join(cacheDir, `${key}-${kind}.jpg`);
}

/** 取某张 RAW 的预览 JPEG：kind = 'big'（全尺寸）/ 'small'（机背缩略图） */
function jpeg(filePath, kind) {
  const k = kind === 'small' ? 'small' : 'big';
  const cf = cachePath(filePath, k);
  try {
    return fs.readFileSync(cf);
  } catch {
    /* 没缓存，现抽 */
  }
  const list = previews(filePath);
  if (!list.length) return null;
  // 小图：优先取 5~200 KB 的那张（机背缩略图），没有就用最小的；
  // 大图：取最大的一张，但那通常是全尺寸预览，几十 MB 的 1:1 预览也照发。
  // 小图取「够大又不是全尺寸」里最小的那张 —— 机背缩略图通常就在 5~300 KB
  const small = list
    .filter((c) => c.length >= 5000 && c.length <= 300 * 1024)
    .sort((a, b) => a.length - b.length)[0];
  const pick = k === 'small' ? small || list[list.length - 1] : list[0];
  const rd = openReader(filePath);
  let buf = null;
  try {
    buf = Buffer.from(rd.read(pick.offset, pick.length));
  } finally {
    rd.close();
  }
  if (!buf || !isJpeg(buf, 0)) return null;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cf}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, cf);
  } catch {
    /* 缓存写不进去就每次现抽，功能不受影响 */
  }
  return buf;
}

/**
 * RAW 的 EXIF：读文件头找不到（RAW 不是 JPEG，没有 APP1），
 * 但内嵌预览图往往带着完整 EXIF（拍摄时间、GPS、机身），所以解析预览图。
 */
function exifOf(filePath, EX) {
  const list = previews(filePath);
  if (!list.length) return null;
  const rd = openReader(filePath);
  try {
    // 预览图可能有好几张，EXIF 一般挂在最大的那张上
    for (const c of list.slice(0, 3)) {
      const buf = rd.read(c.offset, Math.min(c.length, 256 * 1024));
      const r = EX && EX.fromBuffer ? EX.fromBuffer(buf) : null;
      if (r && (r.dateTime || r.lat != null || r.model)) return r;
    }
  } finally {
    rd.close();
  }
  return null;
}

function prune(days) {
  const ttl = (Number(days) || 30) * 86400000;
  const now = Date.now();
  let n = 0;
  try {
    for (const f of fs.readdirSync(cacheDir)) {
      const full = path.join(cacheDir, f);
      try {
        if (now - fs.statSync(full).mtimeMs > ttl) {
          fs.unlinkSync(full);
          n += 1;
        }
      } catch {}
    }
  } catch {}
  return n;
}

/** 仅供测试：直接看 IFD 里的候选（不含扫描兜底） */
function _tiffCandidates(filePath) {
  const rd = openReader(filePath);
  try {
    return tiffCandidates(rd);
  } finally {
    rd.close();
  }
}

module.exports = { init, isRaw, RAW_EXT, previews, jpeg, exifOf, prune, _tiffCandidates };
