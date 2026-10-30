'use strict';
/**
 * 图片内嵌标签：把物种名写进图片文件的元数据里。
 *
 * 支持 JPEG（XMP，Adobe 标准，Lightroom / Google 相册 / Windows 属性都能读）
 * 和 PNG（tEXt 文本块）。
 *
 * 只动元数据段，不解码、不重压像素 —— 画质零损失，文件只会变大几十到几百字节。
 * 原图里已有的 XMP 会尽量保留，只替换 dc:title / dc:description / dc:subject 三项。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const EX = require('./exif');

const XMP_NS = 'http://ns.adobe.com/xap/1.0/';
const XMPMM_NS = 'http://ns.adobe.com/xap/1.0/mm/';
const XMP_HEADER = `${XMP_NS}\u0000`; // APP1 载荷开头这 29 字节是 XMP 的身份证

/* ---------------- 通用小工具 ---------------- */

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** XMP 包里取某个 dc 属性的第一段文字 */
function pick(xml, prop) {
  const re = new RegExp(`<dc:${prop}[\\s\\S]*?<\\/dc:${prop}>`, 'i');
  const block = (xml.match(re) || [])[0];
  if (block) {
    const li = (block.match(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i) || [])[1];
    if (li != null) return unesc(li).trim();
  }
  const attr = new RegExp(`\\bdc:${prop}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return attr ? unesc(attr[1]).trim() : '';
}

function pickBag(xml, prop) {
  const re = new RegExp(`<dc:${prop}[\\s\\S]*?<\\/dc:${prop}>`, 'i');
  const block = (xml.match(re) || [])[0];
  if (!block) return [];
  return [...block.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi)].map((m) => unesc(m[1]).trim()).filter(Boolean);
}

/** 从一段 XMP 里读出我们关心的项 */
function parseXmp(xml) {
  if (!xml) return { title: '', description: '', keywords: [], origName: '' };
  // xmpMM:PreservedFileName：Adobe 用来记「这张图本来叫什么」，改名后仍可回溯
  const mm = /<xmpMM:PreservedFileName[^>]*>([\s\S]*?)<\/xmpMM:PreservedFileName>/i.exec(xml) ||
    /\bxmpMM:PreservedFileName\s*=\s*"([^"]*)"/i.exec(xml);
  return {
    title: pick(xml, 'title'),
    description: pick(xml, 'description'),
    keywords: pickBag(xml, 'subject'),
    origName: mm ? unesc(mm[1]).trim() : '',
  };
}

/* ---------------- XMP 包生成 ---------------- */

/**
 * 生成新的 XMP 包。已有包时只替换三项，其余字段（相机厂商写的 Rating、
 * 后期软件写的 RAW 开发参数等）原样保留。
 * 注意：不做完整 XML 解析，用正则定位 —— 对相机原厂、Lightroom 生成的包都验证过。
 */
function buildPacket(existing, fields) {
  const title = String(fields.title || '').trim();
  const desc = String(fields.description || '').trim();
  const kws = (fields.keywords || []).map((k) => String(k).trim()).filter(Boolean);
  const origName = String(fields.origName || '').trim();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const props =
    (title ? `\n   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>` : '') +
    (desc ? `\n   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(desc)}</rdf:li></rdf:Alt></dc:description>` : '') +
    (kws.length
      ? `\n   <dc:subject><rdf:Bag>${kws.map((k) => `<rdf:li>${esc(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`
      : '') +
    // 记下改名前的名字，下次重新标注还能拼回原名，不会 物种名_物种名_原名 地叠下去
    (origName ? `\n   <xmpMM:PreservedFileName>${esc(origName)}</xmpMM:PreservedFileName>` : '');

  if (existing && /<rdf:RDF[\s\S]*<\/rdf:RDF>/i.test(existing)) {
    let s = existing
      .replace(/<dc:title[\s\S]*?<\/dc:title>/gi, '')
      .replace(/<dc:description[\s\S]*?<\/dc:description>/gi, '')
      .replace(/<dc:subject[\s\S]*?<\/dc:subject>/gi, '')
      .replace(/<xmpMM:PreservedFileName[\s\S]*?<\/xmpMM:PreservedFileName>/gi, '')
      .replace(/\s+dc:title\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+dc:description\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+dc:subject\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+xmpMM:PreservedFileName\s*=\s*"[^"]*"/gi, '');
    if (!/xmlns:dc\s*=/.test(s)) s = s.replace(/<rdf:Description\b/, `<rdf:Description xmlns:dc="${'http://purl.org/dc/elements/1.1/'}"`);
    if (origName && !/xmlns:xmpMM\s*=/.test(s)) {
      s = s.replace(/<rdf:Description\b/, `<rdf:Description xmlns:xmpMM="${XMPMM_NS}"`);
    }
    const at = s.lastIndexOf('</rdf:Description>');
    if (at > 0) {
      s = `${s.slice(0, at)}${props}\n  ${s.slice(at)}`;
      return s.replace(/^\uFEFF/, '').trim();
    }
  }

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="物种标注工坊 tagden">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpMM="${XMPMM_NS}">
   <xmp:CreatorTool>物种标注工坊</xmp:CreatorTool>
   <xmp:ModifyDate>${now}</xmp:ModifyDate>${props}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/* ---------------- JPEG ---------------- */

const SOI = 0xffd8;
const SOS = 0xffda;

/**
 * 头部读得够不够：段结构有没有在缓冲区内走完。
 * 不够就得补读 —— 否则一张 ICC 配置特别大的图会被误判成「没有标签」。
 */
function jpegHeadComplete(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== SOI) return true;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return true;
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return true; // 走到图像数据 / 文件尾就算完
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return true;
    if (off + 2 + len > buf.length) return false; // 段被截断
    off += 2 + len;
  }
  return false;
}

/** 扫一遍段结构，返回 XMP APP1 的 [start, end) 以及可插入位置 */
function scanJpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== SOI) return null;
  let off = 2;
  let xmp = null;
  let insertAt = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    // 无载荷段
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      off += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda) break; // 图像数据开始，后面不用看了
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) break;
    const payload = buf.subarray(off + 4, off + 2 + len);
    if (marker === 0xe1 && payload.subarray(0, XMP_HEADER.length).toString('latin1') === XMP_HEADER) {
      xmp = { start: off, end: off + 2 + len };
    }
    // 插入点：所有 APPn（E0~EF）段之后
    if (marker >= 0xe0 && marker <= 0xef) insertAt = off + 2 + len;
    off += 2 + len;
  }
  return { xmp, insertAt };
}

function jpegRead(buf) {
  const s = scanJpeg(buf);
  if (!s) return null;
  if (!s.xmp) return { xmp: '', has: false };
  const payload = buf.subarray(s.xmp.start + 4, s.xmp.end);
  return { xmp: payload.subarray(XMP_HEADER.length).toString('utf8'), has: true };
}

function jpegWrite(buf, packet) {
  const s = scanJpeg(buf);
  if (!s) throw new Error('不是有效的 JPEG（缺少 SOI 标记）');
  const body = Buffer.from(XMP_HEADER + packet, 'utf8');
  const segLen = body.length + 2;
  if (segLen > 0xffff) throw new Error(`标签内容太大（${body.length} 字节），超过 JPEG 单段 64KB 上限`);

  const seg = Buffer.alloc(2 + segLen);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(segLen, 2);
  body.copy(seg, 4);

  if (s.xmp) {
    return Buffer.concat([buf.subarray(0, s.xmp.start), seg, buf.subarray(s.xmp.end)]);
  }
  return Buffer.concat([buf.subarray(0, s.insertAt), seg, buf.subarray(s.insertAt)]);
}

/* ---------------- PNG ---------------- */

let CRC_TABLE = null;
function crc32(b) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEYS = { title: 'Title', description: 'Description', keywords: 'Keywords', origName: 'OriginalName' };

function pngChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    out.push({ type, start: off, end: off + 12 + len, data: buf.subarray(off + 8, off + 8 + len) });
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

/** PNG 的 tEXt 是 latin1 存的，中文必须用 iTXt（UTF-8） */
function pngTextChunk(keyword, value) {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0, 0, 0, 0, 0]), // 分隔符 + 未压缩 + 空语言标签 + 空翻译键
    Buffer.from(String(value), 'utf8'),
  ]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write('iTXt', 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('iTXt', 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function pngRead(buf) {
  const chunks = pngChunks(buf);
  if (!chunks) return null;
  const found = { title: '', description: '', keywords: [], origName: '' };
  for (const c of chunks) {
    if (c.type !== 'iTXt' && c.type !== 'tEXt') continue;
    const d = c.data;
    const zero = d.indexOf(0);
    if (zero < 0) continue;
    const key = d.subarray(0, zero).toString('latin1');
    let val;
    if (c.type === 'tEXt') {
      val = d.subarray(zero + 1).toString('latin1');
    } else {
      // iTXt：keyword\0 flag method language\0 translated\0 text
      const langEnd = d.indexOf(0, zero + 3);
      const transEnd = langEnd < 0 ? -1 : d.indexOf(0, langEnd + 1);
      val = d.subarray(transEnd < 0 ? zero + 5 : transEnd + 1).toString('utf8');
    }
    if (key === PNG_KEYS.title) found.title = val;
    else if (key === PNG_KEYS.description) found.description = val;
    else if (key === PNG_KEYS.keywords) found.keywords = val.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    else if (key === PNG_KEYS.origName) found.origName = val.trim();
  }
  // 「有没有标注」只看物种名三项，单独记了个原始文件名不算已标注
  return { xmp: '', has: !!(found.title || found.description || found.keywords.length), text: found };
}

function pngWrite(buf, fields) {
  const chunks = pngChunks(buf);
  if (!chunks) throw new Error('不是有效的 PNG');
  const drop = new Set(
    chunks.filter((c) => {
      if (c.type !== 'tEXt' && c.type !== 'iTXt') return false;
      const zero = c.data.indexOf(0);
      const key = zero < 0 ? '' : c.data.subarray(0, zero).toString('latin1');
      return Object.values(PNG_KEYS).includes(key);
    }).map((c) => c.start),
  );

  const parts = [buf.subarray(0, 8)];
  const extra = [];
  if (fields.title) extra.push(pngTextChunk(PNG_KEYS.title, fields.title));
  if (fields.description) extra.push(pngTextChunk(PNG_KEYS.description, fields.description));
  if (fields.keywords?.length) extra.push(pngTextChunk(PNG_KEYS.keywords, fields.keywords.join('; ')));
  if (fields.origName) extra.push(pngTextChunk(PNG_KEYS.origName, fields.origName));

  let inserted = false;
  for (const c of chunks) {
    if (drop.has(c.start)) continue;
    if (c.type === 'IEND' && !inserted) {
      parts.push(...extra);
      inserted = true;
    }
    parts.push(buf.subarray(c.start, c.end));
  }
  return Buffer.concat(parts);
}

/* ---------------- 对外接口 ---------------- */

function kindOf(filePath, buf) {
  const b = buf.subarray(0, 8);
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b.equals(PNG_SIG)) return 'png';
  return 'other';
}

/**
 * 「已标注」的判定标准：标题 / 描述 / 关键词至少有一项有内容。
 * 不能用「有没有 XMP 段」来判断 —— 相机自己也会写一段 XMP（CreatorTool、CreateDate、Rating），
 * 里面根本没有物种名，那样一来所有原图都会被显示成「已标注」。
 */
function fieldsPresent(parsed) {
  return !!(parsed && (parsed.title || parsed.description || (parsed.keywords || []).length));
}

/** 读图片里已有的标签（没有就返回空串） */
function readLabel(filePath) {
  const buf = fs.readFileSync(filePath);
  const kind = kindOf(filePath, buf);
  if (kind === 'jpeg') {
    const r = jpegRead(buf);
    const parsed = parseXmp(r?.xmp || '');
    return { kind, ...parsed, has: !!fieldsPresent(parsed) };
  }
  if (kind === 'png') {
    const r = pngRead(buf);
    return { kind, ...(r?.text || { title: '', description: '', keywords: [], origName: '' }), has: !!r?.has };
  }
  return { kind, title: '', description: '', keywords: [], origName: '', has: false };
}

const baseName = (p) => String(p).replace(/^.*[\\/]/, '');

/**
 * 把物种名写进图片。
 *   fields = { cn, latin, note, source, origName }
 * origName 不传时：文件里记过就沿用，没记过就用当前文件名 —— 这样反复改标也不会把
 * 名字一层层叠成「物种名_物种名_原名」。
 * 返回 { kind, before, after, delta, title, origName }
 */
function writeLabel(filePath, fields) {
  const buf = fs.readFileSync(filePath);
  const kind = kindOf(filePath, buf);
  if (kind === 'other') {
    throw new Error('只支持 JPEG 和 PNG（其他格式请改用「导出记录表」）');
  }
  const cn = String(fields.cn || '').trim();
  const latin = String(fields.latin || '').trim();
  const title = cn || latin;
  const descParts = [];
  if (cn && latin) descParts.push(`${cn} ${latin}`);
  else if (latin) descParts.push(latin);
  const note = String(fields.note || '').trim();
  if (note) descParts.push(note);
  const src = String(fields.source || '').trim();
  if (src) descParts.push(`标注来源：${src}`);

  const keywords = [cn, latin].filter(Boolean);
  if (fields.extraKeywords) keywords.push(...fields.extraKeywords);

  const beforeXmp = kind === 'jpeg' ? jpegRead(buf)?.xmp || '' : '';
  const prev = kind === 'jpeg' ? parseXmp(beforeXmp) : pngRead(buf)?.text || {};
  const origName = String(fields.origName || prev.origName || baseName(filePath)).trim();

  let out;
  if (kind === 'jpeg') {
    out = jpegWrite(buf, buildPacket(beforeXmp, { title, description: descParts.join(' · '), keywords, origName }));
  } else {
    out = pngWrite(buf, { title, description: descParts.join(' · '), keywords, origName });
  }

  const tmp = `${filePath}.tagden-tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, filePath);
  return { kind, before: buf.length, after: out.length, delta: out.length - buf.length, title, origName };
}

/**
 * 列表用的轻量读：只读文件头和尾部，不整读。
 * 一张 20MB 的原图也只用 1MB IO，几百张的文件夹才不会卡住。
 */
function readLabelFast(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // 先读 128KB —— XMP 一定在所有 APPn 之后、SOS 之前，正常照片这已经绰绰有余。
    // 万一某台机器塞了巨大的 ICC 配置导致段被截断，下面会补读到 1MB，正确性不受影响。
    // 几百张照片的文件夹，这一步决定了列表是不是要等半天。
    let head = Buffer.alloc(Math.min(size, 128 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    const kind = kindOf(filePath, head);

    if (kind === 'jpeg' && !jpegHeadComplete(head) && size > head.length) {
      head = Buffer.alloc(Math.min(size, 1024 * 1024));
      fs.readSync(fd, head, 0, head.length, 0);
    }

    if (kind === 'jpeg') return jpegLabel(head);

    if (kind === 'png') {
      const tailLen = Math.min(size, 256 * 1024);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      return pngLabel(tail);
    }

    return { kind, title: '', description: '', keywords: [], origName: '', orient: 1, has: false };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 异步版：同样的字节量，但走 fs.promises，多个文件真正重叠起来。
 *
 * 为什么需要它：readLabelFast 是同步的，await 一堆同步调用不会加速——事件循环照样
 * 一个一个等硬盘。USB 机械盘上「打开 2671 张」从 83 秒降到 20 秒级靠的就是这里。
 */
async function readLabelFastAsync(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    let head = Buffer.alloc(Math.min(size, 128 * 1024));
    await fh.read(head, 0, head.length, 0);
    const kind = kindOf(filePath, head);

    if (kind === 'jpeg' && !jpegHeadComplete(head) && size > head.length) {
      head = Buffer.alloc(Math.min(size, 1024 * 1024));
      await fh.read(head, 0, head.length, 0);
    }

    if (kind === 'jpeg') return jpegLabel(head);

    if (kind === 'png') {
      const tailLen = Math.min(size, 256 * 1024);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      return pngLabel(tail);
    }

    return { kind, title: '', description: '', keywords: [], origName: '', orient: 1, has: false };
  } finally {
    await fh.close();
  }
}

/** JPEG 头部解析：XMP 在 APP1、方向在 EXIF，都在同一个头里 */
function jpegLabel(head) {
  const kind = 'jpeg';
  const r = jpegRead(head);
  // 顺手把方向读出来：缩略图是相机原样存的，浏览器不会替它转正，
  // 得让前端按 orientation 自己转（6=顺时针 90°，3=180°）
  const ex = EX.fromBuffer(head);
  const orient = ex ? ex.orientation : 1;
  // 头 1MB 里没有 XMP 段 → 说明这张图本来就没有标签（XMP 一定在文件开头）
  const parsed = r?.has ? parseXmp(r.xmp) : { title: '', description: '', keywords: [], origName: '' };
  const out = { kind, ...parsed, orient, has: fieldsPresent(parsed) };
  // 头都读进内存了，缩略图顺手带出来：服务端会把它存进 SSD 缓存，
  // 用户滚到这个位置时就不用再开一次原图（USB 机械盘上那是 70ms）。
  // 设成不可枚举：它只是顺路的副产品，不该混进 JSON 返回和缓存记录里。
  Object.defineProperty(out, 'thumb', { value: (ex && ex.thumb) || null, enumerable: false });
  return out;
}

/** PNG 尾部粗扫：iTXt/tEXt 一定在 IEND 前面，所以读尾巴就够 */
function pngLabel(tail) {
  const found = { title: '', description: '', keywords: [], origName: '' };
  // 只找 iTXt/tEXt 的「类型 + 关键字 + \0」开头，不校验长度与 CRC
  for (const m of tail.toString('latin1').matchAll(/(?:iTXt|tEXt)/g)) {
    const at = m.index + 4;
    const zero = tail.indexOf(0, at);
    if (zero < 0 || zero - at > 20) continue;
    const key = tail.subarray(at, zero).toString('latin1');
    let val = '';
    if (m[0] === 'tEXt') {
      const end = tail.indexOf(0, zero + 1);
      val = tail.subarray(zero + 1, end < 0 ? zero + 200 : end).toString('latin1');
    } else {
      const langEnd = tail.indexOf(0, zero + 3);
      const transEnd = langEnd < 0 ? -1 : tail.indexOf(0, langEnd + 1);
      val = tail
        .subarray(transEnd < 0 ? zero + 5 : transEnd + 1, transEnd < 0 ? zero + 400 : transEnd + 400)
        .toString('utf8')
        .replace(/\u0000[\s\S]*$/, '');
    }
    if (key === PNG_KEYS.title) found.title = val.trim();
    else if (key === PNG_KEYS.description) found.description = val.trim();
    else if (key === PNG_KEYS.keywords) found.keywords = val.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    else if (key === PNG_KEYS.origName) found.origName = val.trim();
  }
  return {
    kind: 'png',
    ...found,
    orient: 1,
    has: !!(found.title || found.description || found.keywords.length),
  };
}

module.exports = { readLabel, readLabelFast, readLabelFastAsync, writeLabel, parseXmp, buildPacket, kindOf };
