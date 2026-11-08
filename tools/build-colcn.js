'use strict';
/**
 * 构建期工具：把《中国生物物种名录》（CoL China / 物种2000中国节点，sp2000.org.cn）
 * 的年度版 xlsx 分册，转成随程序内置的紧凑索引 public/colcn.bin。
 *
 * 这只是**开发时**跑一次的工具，不进 exe、运行时零依赖：
 *   lib/colcn.js 只读 public/colcn.bin，纯本地查表，不要 R、不要 API Key、不要联网。
 *
 * 用法
 *   node tools/build-colcn.js --dir <目录>   用本地 5 个 xlsx 分册生成索引
 *   node tools/build-colcn.js --download     自动从 sp2000.org.cn 抓最新年度版再生成
 *   node tools/build-colcn.js --year 2026 --download   指定年度
 *
 * 数据出处：http://sp2000.org.cn/download 的「Catalogue of Life China <年>」分册：
 *   动物界-脊索动物门、动物界-昆虫纲、动物界-其他无脊椎动物、植物界、真菌界。
 * 分册是 xlsx（zip + sharedStrings.xml + worksheets/sheet1.xml），列固定：
 *   A 物种拉丁名 / B 物种中文名 / C..N 界门纲目科属的拉丁名与中文名 / O 审核专家·数据源。
 * 只取 A、B 两列；没填中文名的行跳过（名录里本来就没有，不要拿空串去覆盖识别结果）。
 *
 * 为什么不用 R 包 download_col_china：它下的是整库 .iso（几 GB 的离线独立应用），
 * 不能内置进单文件 exe；这里只抽「学名→中文名」两列做成 1~2 MB 的索引，才是能内置的粒度。
 *
 * 产物格式（gzip 压缩的文本）：
 *   第 1 行：colcn1
 *   第 2 行：<年度版，如 2026>
 *   第 3 行：<条目数>
 *   之后每行：<规范化小写学名>\t<清洗后的中文名>
 * 行按学名排序，便于运行时做二分查找，也保证构建可复现。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'colcn.bin');
const DL_PAGE = 'http://sp2000.org.cn/download';
const DL_BASE = 'http://sp2000.org.cn/CoL/';
const UA = 'tagden-colcn-build/1.0 (local desktop tool; public checklist data)';

/* ---------------- 最小 ZIP 读取（xlsx 就是 zip，Node 只有 zlib 没有 unzip） ---------------- */

/** 从 zip buffer 里取一个文件的原始（解压后）内容。只处理 store(0) / deflate(8)，xlsx 只用这两种。 */
function unzipEntry(buf, wantName) {
  // 1) 从尾部找 EOCD (0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory 起点

  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const exLen = buf.readUInt16LE(p + 30);
    const cmLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + fnLen);
    if (name === wantName) {
      // 2) 读 local file header，算出数据区起点
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lfn = buf.readUInt16LE(localOff + 26);
      const lex = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lfn + lex;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`不支持的 zip 压缩方式 ${method}`);
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  return null;
}

/* ---------------- 极简 XML 取值 ---------------- */

function decodeXml(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16);
      // 名录里的 &#xE000;~&#xF8FF; 是 PUA 造字（缺字替代），没有可显示字形，直接丢掉；
      // 其余（&amp; 之类）按码点还原。
      if (cp >= 0xe000 && cp <= 0xf8ff) return '';
      try { return String.fromCodePoint(cp); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** sharedStrings.xml → 字符串数组。<si> 里可能有多个 <t>（富文本分段），要拼起来。 */
function readSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

/** 取 <c r="A2" t="s"><v>3</v></c> 的值；列号从 r 属性拿，避免空单元格导致错位。 */
function cellValue(cXml, ss) {
  const t = (/\bt="([^"]+)"/.exec(cXml) || [])[1] || '';
  if (t === 'inlineStr') {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let x;
    while ((x = tRe.exec(cXml))) text += decodeXml(x[1]);
    return text;
  }
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cXml);
  if (!v) return '';
  const raw = decodeXml(v[1]);
  if (t === 's') return ss[Number(raw)] || '';
  return raw;
}

/** 遍历 sheet1.xml 的每一行，返回 { A: '...', B: '...' }。用列字母而不是数组下标，抗空单元格。 */
function* readRows(sheetXml, ss) {
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml))) {
    const cells = Object.create(null);
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] !== undefined ? cm[1] : cm[3];
      const body = cm[2] || '';
      const ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1];
      if (ref) cells[ref] = cellValue(body + attrs, ss);
    }
    yield cells;
  }
}

/* ---------------- 清洗 ---------------- */

/** 学名规范化：小写、去亚属括号、去多余空白。和 lib/aggregate.js 的 normLatin 口径一致。 */
function normLatin(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 中文名清洗：名录里混着一些只适合纸面名录、不适合当文件名/展示名的东西。
 *   - PUA 造字实体 &#x0000E060;（缺字替代，无字形）→ 已在 decodeXml 丢掉
 *   - 「，新种」「，新亚种」「，新组合」等分类学标注 → 去掉
 *   - 「（原属Orthocosa）」这类备注 → 去掉括号内容
 *   - 中间多余空白 → 压掉
 * 其余（如「缅甸蟒（双带蚺）」这种并列别名）原样保留：那是名录给的正式中文名。
 */
function cleanCn(s) {
  let c = String(s || '').trim();
  c = c.replace(/[，,]\s*(新种|新亚种|新组合|新记录|新属|新种团)\s*$/u, '');
  c = c.replace(/[（(]原属[^）)]*[）)]/g, '');
  c = c.replace(/\s+/g, '');
  return c.trim();
}

/* ---------------- 下载（--download） ---------------- */

async function fetchText(url, timeout = 30000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchBuffer(url, timeout = 120000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 从下载页 HTML 里筛出指定年度的 5 个 xlsx 分册名。 */
async function latestXlsxNames(wantYear) {
  const html = await fetchText(DL_PAGE);
  const names = [...new Set(
    [...html.matchAll(/([^<>"'\s]*?\.xlsx)/g)].map((m) => m[1].trim()).filter(Boolean)
  )];
  const withYear = names
    .map((n) => ({ n, y: Number((/-(\d{4})-\d+\.xlsx$/.exec(n) || [])[1] || 0) }))
    .filter((x) => x.y > 0);
  if (!withYear.length) throw new Error('下载页里没解析到 xlsx 分册（页面结构可能变了）');
  const year = wantYear || Math.max(...withYear.map((x) => x.y));
  const picked = withYear.filter((x) => x.y === year).map((x) => x.n).sort();
  if (!picked.length) throw new Error(`下载页里没有 ${year} 年度版分册`);
  return { year, names: picked };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : '';
  };
  const dirArg = getArg('--dir');
  const wantYear = Number(getArg('--year')) || 0;
  const doDownload = argv.includes('--download');

  let dir = dirArg ? path.resolve(dirArg) : '';
  let year = wantYear;

  if (doDownload) {
    const info = await latestXlsxNames(wantYear);
    year = info.year;
    dir = path.join(ROOT, '.cache', `colcn-${year}`);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`年度版 ${year}，共 ${info.names.length} 个分册：`);
    for (const n of info.names) {
      const file = path.join(dir, n);
      if (fs.existsSync(file) && fs.statSync(file).size > 10000) {
        console.log(`  已缓存  ${n}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
        continue;
      }
      const buf = await fetchBuffer(DL_BASE + encodeURIComponent(n));
      fs.writeFileSync(file, buf);
      console.log(`  下载    ${n}  ${(buf.length / 1024).toFixed(0)} KB`);
    }
  }

  if (!dir || !fs.existsSync(dir)) {
    console.error('用法：node tools/build-colcn.js --dir <含 xlsx 分册的目录>');
    console.error('  或：node tools/build-colcn.js --download [--year 2026]');
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f)).sort();
  if (!files.length) throw new Error(`${dir} 里没有 xlsx`);
  if (!year) {
    const m = /-(\d{4})-\d+\.xlsx$/.exec(files[0]);
    year = m ? Number(m[1]) : 0;
  }

  /** @type {Map<string,string>} */
  const index = new Map();
  let rawRows = 0;
  let skippedNoCn = 0;
  let conflicts = 0;

  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const sXml = unzipEntry(buf, 'xl/sharedStrings.xml');
    const shXml = unzipEntry(buf, 'xl/worksheets/sheet1.xml');
    if (!shXml) throw new Error(`${f} 里找不到 sheet1.xml`);
    const ss = sXml ? readSharedStrings(sXml.toString('utf8')) : [];
    const sheet = shXml.toString('utf8');
    let n = 0;
    let added = 0;
    for (const cells of readRows(sheet, ss)) {
      const latin = String(cells.A || '').trim();
      // 表头行「物种拉丁名 / 物种中文名」也是普通 <row>，别把它收进索引
      if (latin === '物种拉丁名' || latin === 'Species Latin Name') continue;
      if (!latin) continue;
      n += 1;
      const cn = cleanCn(cells.B || '');
      if (!cn) { skippedNoCn += 1; continue; }
      const key = normLatin(latin);
      if (!key) continue;
      // 同名冲突只有极少数（不同界撞名）：先到先得，保证可复现
      if (index.has(key) && index.get(key) !== cn) conflicts += 1;
      else { index.set(key, cn); added += 1; }
    }
    rawRows += n;
    console.log(`  ${f.padEnd(42)} 行 ${String(n).padStart(7)}  收录 ${String(added).padStart(7)}`);
  }

  const lines = [...index.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}\t${v}`);
  const body = `colcn1\n${year}\n${lines.length}\n${lines.join('\n')}\n`;
  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, gz);

  console.log('');
  console.log(`原始行 ${rawRows}，无中文名跳过 ${skippedNoCn}，同名冲突忽略 ${conflicts}`);
  console.log(`索引条目 ${lines.length}，年度版 ${year}`);
  console.log(`未压缩 ${(Buffer.byteLength(body) / 1048576).toFixed(2)} MB → gzip ${(gz.length / 1048576).toFixed(2)} MB`);
  console.log(`已写入 ${OUT}`);
  // 抽查：让用户一眼看到权威名与俗称的差别
  for (const probe of ['papilio bianor', 'luehdorfia chinensis', 'ginkgo biloba', 'aspidistra fungilliformis']) {
    console.log(`  ${probe.padEnd(32)} → ${index.get(probe) || '（未收录）'}`);
  }
}

main().catch((err) => {
  console.error(`构建失败：${err.stack || err.message || err}`);
  process.exit(1);
});
