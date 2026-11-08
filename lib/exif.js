'use strict';
/**
 * 零依赖 EXIF 读取（只读，从不写）。
 *
 * 只做三件标注工作真用得上事：
 *   1. 取出相机自己嵌的缩略图 —— 列表里 5 KB 的小图代替 8 MB 的原图
 *   2. 拍摄时间 DateTimeOriginal
 *   3. GPS 经纬度 / 海拔
 *
 * 照片是用户的，任何结构异常都必须安静地返回空值：一张坏 EXIF 不能把整批标注卡住。
 * 所有偏移都先做边界检查再读，绝不信任文件里的长度字段。
 */

const fs = require('node:fs');

const T_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** 读文件头。EXIF 的 APP1 最大 64 KB 且一定在图像数据之前，256 KB 足够 */
const HEAD_BYTES = 256 * 1024;
/** 头部找不到时，整读到这个上限为止（导出坐标时用，宁可慢也不能漏） */
const FULL_LIMIT = 48 * 1024 * 1024;

const EMPTY = Object.freeze({
  ok: false,
  orientation: 1,
  dateTime: '',
  make: '',
  model: '',
  width: 0,
  height: 0,
  lat: null,
  lon: null,
  alt: null,
  iso: null,
  thumb: null,
});

/** 在 JPEG 的段结构里找 Exif APP1，返回 TIFF 数据的起止位置 */
function findExifApp1(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  let guard = 0;
  while (off + 4 <= buf.length && guard < 512) {
    guard += 1;
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off += 1; // 填充字节
      continue;
    }
    // 无长度的标记：重启标记、TEM、SOI
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    // SOS = 图像数据开始，EOI = 文件结束；EXIF 不可能在后面
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    const body = off + 4;
    const end = off + 2 + len;
    if (end > buf.length) return null; // 头读得不够，交给上层决定要不要整读
    if (marker === 0xe1 && buf.toString('latin1', body, body + 6) === 'Exif\0\0') {
      return { start: body + 6, end };
    }
    off = end;
  }
  return null;
}

/** 解析 TIFF 结构。start 是 TIFF 头（II/MM）的位置，end 是 APP1 末尾 */
function parseTiff(buf, start, end) {
  const limit = end - start;
  if (limit < 8) return null;
  const order = buf.toString('latin1', start, start + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;

  const u16 = (o) => (le ? buf.readUInt16LE(start + o) : buf.readUInt16BE(start + o));
  const u32 = (o) => (le ? buf.readUInt32LE(start + o) : buf.readUInt32BE(start + o));
  if (u16(2) !== 42) return null;

  const readIFD = (at) => {
    if (!at || at < 8 || at + 2 > limit) return null;
    const n = u16(at);
    if (!n || n > 512) return null;
    if (at + 2 + n * 12 + 4 > limit) return null;
    const tags = new Map();
    for (let i = 0; i < n; i += 1) {
      const e = at + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (T_SIZE[type] || 0) * count;
      if (!size || size > limit) continue;
      const valueAt = size <= 4 ? e + 8 : u32(e + 8);
      if (valueAt < 0 || valueAt + size > limit) continue;
      tags.set(tag, { type, count, size, at: valueAt });
    }
    return { tags, next: u32(at + 2 + n * 12) };
  };

  const bytes = (ent) => buf.subarray(start + ent.at, start + ent.at + ent.size);

  const str = (ent) => {
    if (!ent) return '';
    const b = bytes(ent);
    const z = b.indexOf(0);
    return b.toString('latin1', 0, z < 0 ? b.length : z).replace(/\0/g, '').trim();
  };

  const num = (ent, i = 0) => {
    if (!ent) return null;
    const b = bytes(ent);
    const o = i * (T_SIZE[ent.type] || 0);
    try {
      switch (ent.type) {
        case 1:
        case 7:
          return b[o];
        case 3:
          return le ? b.readUInt16LE(o) : b.readUInt16BE(o);
        case 4:
          return le ? b.readUInt32LE(o) : b.readUInt32BE(o);
        case 9:
          return le ? b.readInt32LE(o) : b.readInt32BE(o);
        case 5: {
          const n = le ? b.readUInt32LE(o) : b.readUInt32BE(o);
          const d = le ? b.readUInt32LE(o + 4) : b.readUInt32BE(o + 4);
          return d ? n / d : null;
        }
        case 10: {
          const n = le ? b.readInt32LE(o) : b.readInt32BE(o);
          const d = le ? b.readInt32LE(o + 4) : b.readInt32BE(o + 4);
          return d ? n / d : null;
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  };

  /** "2026:10:20 14:33:05" → "2026-10-20 14:33:05"；全 0 的占位值当没有 */
  const normDate = (s) => {
    const m = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return '';
    if (m[1] === '0000') return '';
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  };

  const ifd0 = readIFD(u32(4));
  if (!ifd0) return null;

  const out = {
    ok: true,
    order,
    orientation: 1,
    dateTime: '',
    make: '',
    model: '',
    width: 0,
    height: 0,
    lat: null,
    lon: null,
    alt: null,
    iso: null,
    thumb: null,
  };

  out.orientation = num(ifd0.tags.get(0x0112)) || 1;
  out.make = str(ifd0.tags.get(0x010f));
  out.model = str(ifd0.tags.get(0x0110));
  out.width = num(ifd0.tags.get(0x0100)) || 0;
  out.height = num(ifd0.tags.get(0x0101)) || 0;
  // ISO 感光度（0x8827）：照片评分的「高感补偿」要用，少数相机放 IFD0，多数在 ExifIFD
  out.iso = num(ifd0.tags.get(0x8827)) || null;

  const exifPtr = num(ifd0.tags.get(0x8769));
  if (exifPtr) {
    const exif = readIFD(exifPtr);
    if (exif) {
      if (!out.iso) out.iso = num(exif.tags.get(0x8827)) || null;
      out.dateTime =
        normDate(str(exif.tags.get(0x9003))) || // DateTimeOriginal
        normDate(str(exif.tags.get(0x9004))) || // DateTimeDigitized
        normDate(str(ifd0.tags.get(0x0132))); //  IFD0 DateTime（改过图的）
    }
  }

  const gpsPtr = num(ifd0.tags.get(0x8825));
  if (gpsPtr) {
    const gps = readIFD(gpsPtr);
    if (gps) {
      const latRef = str(gps.tags.get(0x0001)).toUpperCase();
      const lonRef = str(gps.tags.get(0x0003)).toUpperCase();
      const latEnt = gps.tags.get(0x0002);
      const lonEnt = gps.tags.get(0x0004);
      const dms = (ent) => {
        if (!ent || ent.count < 3) return null;
        const d = num(ent, 0);
        const m = num(ent, 1);
        const s = num(ent, 2);
        if (d == null || m == null || s == null) return null;
        const v = d + m / 60 + s / 3600;
        return Number.isFinite(v) ? v : null;
      };
      const la = dms(latEnt);
      const lo = dms(lonEnt);
      if (la != null && la <= 90) out.lat = latRef === 'S' ? -la : la;
      if (lo != null && lo <= 180) out.lon = lonRef === 'W' ? -lo : lo;
      if (out.lat === 0 && out.lon === 0) {
        // 0,0 基本都是「没定位」而不是真的在几内亚湾
        out.lat = null;
        out.lon = null;
      }
      const altEnt = gps.tags.get(0x0006);
      const alt = num(altEnt);
      if (alt != null) out.alt = num(gps.tags.get(0x0005)) === 1 ? -alt : alt;
    }
  }

  // IFD1 里的缩略图：0x0201 偏移、0x0202 长度
  const ifd1 = ifd0.next ? readIFD(ifd0.next) : null;
  if (ifd1) {
    const off = num(ifd1.tags.get(0x0201));
    const len = num(ifd1.tags.get(0x0202));
    if (off > 0 && len > 4 && off + len <= limit) {
      const t = buf.subarray(start + off, start + off + len);
      // 必须真的是 JPEG 才要（有些机型写成别的编码）
      if (t[0] === 0xff && t[1] === 0xd8 && t[t.length - 2] === 0xff && t[t.length - 1] === 0xd9) {
        out.thumb = t;
      }
    }
  }

  return out;
}

/** 从一段内存里读（调用方自己决定读了多少） */
function fromBuffer(buf) {
  try {
    const app = findExifApp1(buf);
    if (!app) return null;
    return parseTiff(buf, app.start, app.end);
  } catch {
    return null;
  }
}

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    return { head, size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 完整读一遍 EXIF。头部找不到、文件又不大时整读 —— 有些软件把 EXIF 写在了
 * 大段 XMP 之后，256 KB 未必够。
 */
function meta(filePath) {
  try {
    const { head, size } = readHead(filePath);
    const quick = fromBuffer(head);
    if (quick || size <= head.length || size > FULL_LIMIT) return quick || { ...EMPTY };
    const all = fromBuffer(fs.readFileSync(filePath));
    return all || { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** 只要缩略图（列表用，绝不整读文件） */
function thumb(filePath) {
  try {
    const { head } = readHead(filePath);
    const r = fromBuffer(head);
    return r && r.thumb ? r : null;
  } catch {
    return null;
  }
}

/**
 * 抽出「标注来源」和「备注」。
 * 写进去的描述长这样：中文名 学名 · 备注 · 标注来源：晓虫 + 多识
 * 用户自己改过描述读不出来也无所谓，导出时留空即可。
 */
function splitDescription(desc) {
  const parts = String(desc || '')
    .split(' · ')
    .map((s) => s.trim())
    .filter(Boolean);
  let source = '';
  const rest = [];
  for (const p of parts) {
    const m = /^标注来源[：:]\s*(.+)$/.exec(p);
    if (m) source = m[1].trim();
    else rest.push(p);
  }
  // 第一段是「中文名 学名」，导出时用不到（有单独列）
  if (rest.length && /^[^ ]+ [A-Z][a-z]/.test(rest[0])) rest.shift();
  return { note: rest.join(' · '), source };
}

module.exports = { meta, thumb, fromBuffer, splitDescription, EMPTY };
