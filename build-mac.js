'use strict';

/**
 * 构建 macOS 版（可在 Windows / Linux 上交叉构建，不需要 Mac）
 *
 *   node build-mac.js                   → 版本号取 .version，arm64 + x64 都出
 *   node build-mac.js --arch arm64      → 只出 M 芯片那一份
 *   node build-mac.js 0.5.3             → 指定版本号
 *   node build-mac.js --notes "改了啥"  → 写进更新清单（缺省读 notes.txt）
 *
 * 产物（dist-mac/）：
 *   物种标注工坊-mac-arm64.zip   首次安装用；解压后双击 start.command
 *   main-<version>.js            自动更新的替换包（arm64/x64 共用一份）
 *   latest-mac.json              更新清单，和 Windows 的 latest.json 分开
 *
 * 为什么不用 exe 那套 SEA 注入：
 *   苹果要求每个可执行文件都有签名，而注入字节会把 node 官方签名弄坏，
 *   重新签名（codesign）只能在 macOS 上做。所以这里换个更稳的思路 ——
 *   node 运行时原样不动（签名继续有效），程序代码放在它旁边，
 *   由 start.command 调起来。体积和单文件差不多，但不会因为签名问题打不开。
 *
 * 为什么更新包只有一个 main.js：
 *   程序全在 app/main.js 里，而 JS 与 CPU 架构无关。所以更新时只替换这一个文件，
 *   arm64 / x64 共用同一份更新包 —— 既快（~300 KB）又不会装错架构。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildBundle } = require('./build/bundle');
const { createZip } = require('./build/zip');
const { extractFile } = require('./build/tar');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist-mac');
const VERSION_FILE = path.join(ROOT, '.version');
const NODE_VER = 'v22.22.2';
const PKG_NAME = '物种标注工坊-mac';

/**
 * node 运行时的 tar.gz 缓存。自己没有就去借聚合台下过的那份 ——
 * 两个程序用的是同一个 Node 版本，没必要为了出一版 mac 再下 100 MB。
 */
const CACHE_DIRS = [path.join(ROOT, '.cache'), path.join(ROOT, '..', 'bio-id-hub', '.cache')];

/* ---------------- 参数 ---------------- */

const ARCHS = (() => {
  const i = process.argv.indexOf('--arch');
  if (i >= 0 && process.argv[i + 1]) return [process.argv[i + 1]];
  return ['arm64', 'x64'];
})();

/** 版本号：命令行参数 > .version。mac 版不自动 +1，避免和 exe 的版本号错位 */
function resolveVersion() {
  const explicit = process.argv.slice(2).find((a) => /^v?\d+\.\d+\.\d+/.test(a));
  if (explicit) return explicit.replace(/^v/i, '');
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function resolveNotes() {
  const i = process.argv.indexOf('--notes');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  try {
    return fs.readFileSync(path.join(ROOT, 'notes.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveUpdateUrl() {
  const i = process.argv.indexOf('--update-url');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].trim();
  if (process.env.TAGDEN_UPDATE_URL) return process.env.TAGDEN_UPDATE_URL.trim();
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8')).url || '').trim();
  } catch {
    return '';
  }
}

/* ---------------- node 运行时 ---------------- */

/**
 * 离线复用：--node-bin 指到已经解出来的 node 二进制（比如聚合台产物里的 node），
 * 就不用再下 45 MB 的 tar.gz。只影响本地构建，发布产物内容完全一样。
 */
const NODE_BIN = (() => {
  const i = process.argv.indexOf('--node-bin');
  const v = i >= 0 ? process.argv[i + 1] : process.env.TAGDEN_NODE_BIN || '';
  return v && fs.existsSync(v) ? v : '';
})();

function findCached(arch) {
  const name = `node-${NODE_VER}-darwin-${arch}.tar.gz`;
  for (const dir of CACHE_DIRS) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).size > 10 * 1024 * 1024) return file;
    } catch {
      /* 这个目录没有，看下一个 */
    }
  }
  return '';
}

async function cacheTarball(arch) {
  const cached = findCached(arch);
  if (cached) {
    console.log(`  复用已缓存的 ${path.relative(ROOT, cached) || cached}`);
    return cached;
  }
  const dir = CACHE_DIRS[0];
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `node-${NODE_VER}-darwin-${arch}.tar.gz`);
  const url = `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${arch}.tar.gz`;
  console.log(`  下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  console.log(`  已缓存 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return file;
}

function extractNode(tarball, arch) {
  const inner = `node-${NODE_VER}-darwin-${arch}/bin/node`;
  const bin = extractFile(fs.readFileSync(tarball), inner);
  if (!bin || bin.length < 1024) throw new Error('压缩包里没找到 bin/node');
  // 确认拿到的是 64 位 Mach-O，而不是壳脚本或不完整文件
  const magic = bin.readUInt32BE(0);
  if (magic !== 0xcffaedfe && magic !== 0xcafebabe) {
    throw new Error(`不是 Mach-O 可执行文件（magic=0x${magic.toString(16)}）`);
  }
  return bin;
}

/* ---------------- 单个架构 ---------------- */

async function buildArch(arch, ctx) {
  console.log(`\n=== ${arch} ===`);
  let nodeBin;
  if (NODE_BIN) {
    nodeBin = fs.readFileSync(NODE_BIN);
    const magic = nodeBin.readUInt32BE(0);
    if (magic !== 0xcffaedfe && magic !== 0xcafebabe) {
      throw new Error(`--node-bin 不是 Mach-O（magic=0x${magic.toString(16)}）`);
    }
    console.log(`  node 运行时（复用 ${path.basename(NODE_BIN)}）${(nodeBin.length / 1024 / 1024).toFixed(1)} MB`);
  } else {
    nodeBin = extractNode(await cacheTarball(arch), arch);
    console.log(`  node 运行时 ${(nodeBin.length / 1024 / 1024).toFixed(1)} MB`);
  }

  const stageName = `${PKG_NAME}-${arch}`;
  const stage = path.join(OUT_DIR, stageName);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'app'), { recursive: true });

  const startCommand = fs.readFileSync(path.join(ROOT, 'release-mac', 'start.command'));
  const readme = fs.readFileSync(path.join(ROOT, 'release-mac', '使用说明.txt'));

  fs.writeFileSync(path.join(stage, 'node'), nodeBin);
  fs.writeFileSync(path.join(stage, 'app', 'main.js'), ctx.mainJs, 'utf8');
  fs.writeFileSync(path.join(stage, 'start.command'), startCommand);
  fs.writeFileSync(path.join(stage, '使用说明.txt'), readme);

  const entries = [
    { name: `${stageName}/`, mode: 0o40755 },
    { name: `${stageName}/start.command`, data: startCommand, mode: 0o100755 },
    { name: `${stageName}/node`, data: nodeBin, mode: 0o100755 },
    { name: `${stageName}/app/`, mode: 0o40755 },
    { name: `${stageName}/app/main.js`, data: Buffer.from(ctx.mainJs, 'utf8'), mode: 0o100644 },
    { name: `${stageName}/使用说明.txt`, data: readme, mode: 0o100644 },
  ];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = path.join(OUT_DIR, `${stageName}.zip`);
  const zip = createZip(entries);
  fs.writeFileSync(zipPath, zip);
  console.log(`  完成 ${path.basename(zipPath)}  ${(zip.length / 1024 / 1024).toFixed(1)} MB`);
  return zipPath;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const version = resolveVersion();
  const notes = resolveNotes();
  const updateUrl = resolveUpdateUrl();

  console.log(`→ 版本 v${version}${updateUrl ? `，更新源 ${updateUrl}` : '（未配置更新源）'}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 一份 main.js 给所有架构用：程序代码与 CPU 无关
  const mainJs = buildBundle(ROOT, {
    name: '物种标注工坊',
    version,
    updateUrl,
    builtAt: new Date().toISOString(),
  });
  console.log(`→ 程序包 main.js ${(Buffer.byteLength(mainJs) / 1024).toFixed(1)} KB`);

  const checkPath = path.join(OUT_DIR, '~check-main.js');
  fs.writeFileSync(checkPath, mainJs, 'utf8');
  execFileSync(process.execPath, ['--check', checkPath], { stdio: 'inherit' });
  fs.rmSync(checkPath, { force: true });

  const zips = [];
  for (const arch of ARCHS) zips.push(await buildArch(arch, { mainJs, version }));

  /* ---------- 自动更新的发布物 ---------- */

  const assetName = `main-${version}.js`;
  const assetPath = path.join(OUT_DIR, assetName);
  fs.writeFileSync(assetPath, mainJs, 'utf8');

  const buf = fs.readFileSync(assetPath);
  const manifest = {
    version,
    notes,
    app: 'mac',
    url: assetName,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    pubDate: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'latest-mac.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('\n全部完成：');
  for (const p of zips) console.log('  ' + path.basename(p));
  console.log('  ' + assetName + '        自动更新包（两架构共用）');
  console.log('  latest-mac.json                  更新清单');
  console.log(`\n  SHA-256  ${manifest.sha256}`);
  console.log('\n首次安装：把 zip 发给对方，解压后双击 start.command（首次可能需放行一次）。');
  console.log('自动更新：把 ' + assetName + ' 和 latest-mac.json 传到更新源同一目录即可。');
})().catch((err) => {
  console.error('构建失败：' + err.message);
  process.exit(1);
});
