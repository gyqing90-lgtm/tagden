'use strict';
/**
 * RAW 支持：不解像素，只掏相机内嵌的 JPEG 预览。
 * 这里用「合成的 NEF/CR3」验证解析与取图 —— 真机 RAW 太大，不适合进仓库。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAW = require('../lib/raw.js');
const EX = require('../lib/exif.js');

/** 造一张只有 EXIF DateTime 的极小 JPEG（够 exif.js 解析即可） */
function jpegWithDate(dateTime) {
  const str = Buffer.from(`${dateTime}\0`, 'ascii'); // 20 字节
  const ifdOff = 8;
  const tiffLen = ifdOff + 2 + 12 + 4 + str.length;
  const tiff = Buffer.alloc(tiffLen);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifdOff, 4);
  tiff.writeUInt16LE(1, ifdOff); // 1 个 entry
  const e = ifdOff + 2;
  tiff.writeUInt16LE(0x0132, e); // DateTime
  tiff.writeUInt16LE(2, e + 2); // ASCII
  tiff.writeUInt32LE(str.length, e + 4);
  tiff.writeUInt32LE(e + 12 + 4, e + 8);
  tiff.writeUInt32LE(0, e + 12);
  str.copy(tiff, e + 12 + 4);

  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, Buffer.from([0xff, 0xd9])]);
}

/** 把 JPEG 撑到指定字节数（预览图都 >2 KB，太小的假图会被当成坏项过滤） */
function padJpeg(b, size) {
  if (b.length >= size) return b;
  return Buffer.concat([b.slice(0, b.length - 2), Buffer.alloc(size - b.length, 0), b.slice(-2)]);
}

/** 把若干 JPEG 塞进一个最小 TIFF 容器（IFD0 + SubIFD），返回 .nef 用的 Buffer */
function tiffContainer(jpegs) {
  const n = jpegs.length;
  const entries = n ? 2 : 1; // ImageWidth + (SubIFDs)
  const ifd0 = 8;
  const ifd0End = ifd0 + 2 + entries * 12 + 4;
  const arrLen = n > 1 ? n * 4 : 0; // SubIFDs 只有 1 个时偏移直接内联，不留数组
  const arrOff = ifd0End;
  const subSize = 2 + 2 * 12 + 4;
  const subOffs = [];
  let cursor = ifd0End + arrLen;
  const dataOffs = [];
  for (const j of jpegs) {
    subOffs.push(cursor);
    dataOffs.push(cursor + subSize);
    cursor += subSize + j.length;
  }

  const out = Buffer.alloc(cursor);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0, 4);
  out.writeUInt16LE(entries, ifd0);

  let p = ifd0 + 2;
  const ent = (tag, type, cnt, val) => {
    out.writeUInt16LE(tag, p);
    out.writeUInt16LE(type, p + 2);
    out.writeUInt32LE(cnt, p + 4);
    out.writeUInt32LE(val, p + 8);
    p += 12;
  };
  ent(0x0100, 3, 1, 6000); // ImageWidth
  if (n === 1) {
    ent(0x014a, 4, 1, subOffs[0]); // 单个 SubIFD：值就是偏移本身
  } else if (n > 1) {
    subOffs.forEach((off, i) => out.writeUInt32LE(off, arrOff + i * 4));
    ent(0x014a, 4, n, arrOff);
  }
  out.writeUInt32LE(0, p); // 没有 IFD1

  jpegs.forEach((j, i) => {
    const s = subOffs[i];
    out.writeUInt16LE(2, s);
    out.writeUInt16LE(0x0201, s + 2);
    out.writeUInt16LE(4, s + 4);
    out.writeUInt32LE(1, s + 6);
    out.writeUInt32LE(dataOffs[i], s + 10);
    out.writeUInt16LE(0x0202, s + 14);
    out.writeUInt16LE(4, s + 16);
    out.writeUInt32LE(1, s + 18);
    out.writeUInt32LE(j.length, s + 22);
    out.writeUInt32LE(0, s + 26);
    j.copy(out, dataOffs[i]);
  });
  return out;
}

function workdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-raw-'));
  RAW.init({ cacheDir: path.join(dir, 'cache') });
  return dir;
}

test('认得 RAW 扩展名，不误伤普通图', () => {
  for (const n of ['a.NEF', 'b.cr2', 'c.CR3', 'd.arw', 'e.dng', 'f.raf', 'g.orf', 'h.rw2']) {
    assert.equal(RAW.isRaw(n), true, `${n} 应识别为 RAW`);
  }
  for (const n of ['a.jpg', 'b.png', 'c.heic', 'd.txt', '']) assert.equal(RAW.isRaw(n), false);
});

test('从 TIFF 的 SubIFD 里找到预览并原样取回', () => {
  const dir = workdir();
  const jpg = padJpeg(jpegWithDate('2026:05:01 08:30:00'), 4096);
  const nef = path.join(dir, 'shot.nef');
  fs.writeFileSync(nef, tiffContainer([jpg]));

  const cands = RAW._tiffCandidates(nef);
  assert.equal(cands.length, 1, '应找到一个候选');
  assert.equal(cands[0].length, jpg.length);

  const got = RAW.jpeg(nef);
  assert.ok(got && got.equals(jpg), '取回的字节要和嵌进去的一模一样');

  // 第二次走磁盘缓存
  const first = fs.readdirSync(path.join(dir, 'cache', 'raw')).filter((f) => f.endsWith('-big.jpg'));
  assert.equal(first.length, 1, '预览应落一份缓存（cache/raw/）');
  assert.equal(RAW.jpeg(nef).equals(jpg), true);
});

test('小图优先取机背缩略图，大图取最大的一张', () => {
  const dir = workdir();
  const big = Buffer.concat([jpegWithDate('2026:05:01 08:30:00'), Buffer.alloc(40000, 1)]);
  const small = Buffer.concat([jpegWithDate('2026:05:01 08:30:00'), Buffer.alloc(8000, 2)]);
  const nef = path.join(dir, 'two.nef');
  fs.writeFileSync(nef, tiffContainer([big, small]));

  const all = RAW.previews(nef);
  assert.equal(all.length, 2);
  assert.ok(all[0].length > all[1].length, '按大小降序');
  assert.equal(RAW.jpeg(nef, 'big').length, big.length);
  assert.equal(RAW.jpeg(nef, 'small').length, small.length);
});

test('非 TIFF 容器（CR3）退化成扫描 SOI…EOI', () => {
  const dir = workdir();
  const jpg = padJpeg(jpegWithDate('2026:06:02 09:00:00'), 4096);
  const cr3 = path.join(dir, 'x.cr3');
  fs.writeFileSync(cr3, Buffer.concat([Buffer.alloc(30000, 7), jpg, Buffer.alloc(5000, 8)]));
  const got = RAW.jpeg(cr3);
  assert.ok(got && got.equals(jpg));
});

test('RAW 的拍摄时间从内嵌预览的 EXIF 里读', () => {
  const dir = workdir();
  const jpg = padJpeg(jpegWithDate('2026:05:01 08:30:00'), 4096);
  const nef = path.join(dir, 'exif.nef');
  fs.writeFileSync(nef, tiffContainer([jpg]));
  const r = RAW.exifOf(nef, EX);
  assert.ok(r, '应能解析出 EXIF');
  // exif.js 把 EXIF 的 2026:05:01 统一成 ISO 风格
  assert.equal(r.dateTime, '2026-05-01 08:30:00');
});

test('没有内嵌预览时返回 null，不许抛错', () => {
  const dir = workdir();
  const nef = path.join(dir, 'empty.nef');
  fs.writeFileSync(nef, Buffer.alloc(4096, 0));
  assert.deepEqual(RAW.previews(nef), []);
  assert.equal(RAW.jpeg(nef), null);
  assert.equal(RAW.exifOf(nef, EX), null);
});

test('server 把 RAW 当图片：/img 回 JPEG、写标签被拦、统计能读到', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /\.\.\.RAW\.RAW_EXT/);
  assert.match(src, /if \(RAW\.isRaw\(full\)\) \{\s*\n\s*let j = null;/, '/img 应优先回内嵌预览');
  assert.match(src, /RAW\.jpeg\(full, 'small'\)/, '缩略图用机背小图');
  assert.match(src, /RAW 只支持看图、识别和评分/, '写标签要被拦下');
  assert.match(src, /RAW\.exifOf\(f\.full, EX\)/, '统计要读预览里的 EXIF');
});

test('打包清单里有 raw.js（漏了 exe 会报模块未打包）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'bundle.js'), 'utf8');
  assert.match(src, /'lib\/raw\.js'/);
});
