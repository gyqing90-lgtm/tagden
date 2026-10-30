'use strict';

/**
 * 打包脚本：把源码 + 网页资源 + Node 运行时合成单个 exe。
 *
 *   node build-exe.js                 补丁号 +1
 *   node build-exe.js 0.4.2           指定版本
 *   node build-exe.js --bump minor    递增次版本号
 *   node build-exe.js --out dist      换个输出目录
 *
 * 产物默认就放在项目根目录：`物种标注工坊.exe`。
 * 这么放是有意的 —— 程序读同级的 data/，放在这儿正好接着用你现有的账号配置；
 * 拷到别的机器上，它会在同目录新建一个空的 data，让你重新填。
 *
 * 原理和聚合台一致：
 *   1. build/bundle.js 把 server + lib 合成一个 CJS 文件，public/ 内联成字符串
 *   2. Node 官方 SEA 把该文件做成 blob
 *   3. postject 把 blob 注入 node.exe 的副本
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildBundle } = require('./build/bundle');

const ROOT = __dirname;
const BUILD = path.join(ROOT, '.build');
const EXE_NAME = '物种标注工坊.exe';
const POSTJECT = path.join(ROOT, '.build-tools', 'node_modules', 'postject', 'dist', 'cli.js');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const VERSION_FILE = path.join(ROOT, '.version');

function runNode(args, opts = {}) {
  return execFileSync(process.execPath, args, { stdio: 'inherit', ...opts });
}

function resolveVersion(argv) {
  const explicit = argv.find((a) => /^v?\d+\.\d+\.\d+$/.test(a));
  if (explicit) return explicit.replace(/^v/i, '');

  let cur = '';
  try {
    cur = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    /* 首次构建 */
  }
  if (!cur) return '0.4.2';

  const [a = 0, b = 0, c = 0] = cur.replace(/^v/i, '').split('.').map((n) => Number(n) || 0);
  const bump = argv[argv.indexOf('--bump') + 1];
  if (bump === 'major') return `${a + 1}.0.0`;
  if (bump === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

function resolveOutDir(argv) {
  const idx = argv.indexOf('--out');
  const rel = idx >= 0 && argv[idx + 1] ? argv[idx + 1] : '.';
  return path.resolve(ROOT, rel);
}

/**
 * 更新源：--update-url 参数 > 环境变量 > update.json。
 * 编译进 exe 之后用户改不了，所以只在打包时确定。
 */
function resolveUpdateUrl(argv) {
  const idx = argv.indexOf('--update-url');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1].trim();
  if (process.env.TAGDEN_UPDATE_URL) return process.env.TAGDEN_UPDATE_URL.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8'));
    return String(cfg.url || '').trim();
  } catch {
    return '';
  }
}

function resolveNotes(argv) {
  const idx = argv.indexOf('--notes');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  try {
    return fs.readFileSync(path.join(ROOT, 'notes.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function main() {
  const argv = process.argv.slice(2);
  const version = resolveVersion(argv);
  const outDir = resolveOutDir(argv);
  const exePath = path.join(outDir, EXE_NAME);
  const updateUrl = resolveUpdateUrl(argv);
  const notes = resolveNotes(argv);

  console.log(`→ 版本 v${version}${updateUrl ? `，更新源 ${updateUrl}` : '（未配置更新源）'}`);
  console.log(`→ 输出 ${exePath}`);

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  console.log('→ 生成单文件 JS 包');
  const mainJs = buildBundle(ROOT, {
    name: '物种标注工坊',
    version,
    updateUrl,
    builtAt: new Date().toISOString(),
  });
  const mainPath = path.join(BUILD, 'main.js');
  fs.writeFileSync(mainPath, mainJs, 'utf8');
  console.log(`  main.js  ${(Buffer.byteLength(mainJs) / 1024).toFixed(1)} KB`);

  // 先只做语法与依赖检查，别等打完 80MB 才发现少了个模块
  console.log('→ 校验打包结果');
  execFileSync(process.execPath, ['--check', mainPath], { stdio: 'inherit' });

  console.log('→ 生成 SEA blob');
  const seaConfig = {
    main: path.relative(ROOT, mainPath).replace(/\\/g, '/'),
    output: path.relative(ROOT, path.join(BUILD, 'sea-prep.blob')).replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  const seaConfigPath = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');
  runNode(['--experimental-sea-config', seaConfigPath]);

  // 先写临时文件再改名：exe 正在运行时直接覆盖会 EPERM
  const TMP_PATH = path.join(outDir, `~${EXE_NAME}`);
  console.log('→ 复制 Node 运行时');
  fs.copyFileSync(process.execPath, TMP_PATH);

  console.log('→ 注入 blob');
  if (!fs.existsSync(POSTJECT)) {
    throw new Error('缺少 postject，请先执行：npm install --prefix .build-tools postject');
  }
  try {
    runNode([POSTJECT, TMP_PATH, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', SENTINEL]);
  } catch (err) {
    // 注入阶段 postject 会嘀咕一句「签名看起来是坏的」，那是正常的，别吓人
    console.log('  （postject 的 warning 属正常，下面以最终产物为准）');
  }

  console.log('→ 替换成品');
  try {
    if (fs.existsSync(exePath)) {
      const old = path.join(outDir, '~old.exe');
      try {
        if (fs.existsSync(old)) fs.rmSync(old, { force: true });
        fs.renameSync(exePath, old);
      } catch {
        /* 挪不动就把旧文件留着，下面改名会失败并给出提示 */
      }
    }
    fs.renameSync(TMP_PATH, exePath);
    const old = path.join(outDir, '~old.exe');
    if (fs.existsSync(old)) fs.rmSync(old, { force: true });
  } catch (err) {
    fs.rmSync(TMP_PATH, { force: true });
    throw new Error(
      `写不进去：${err.message}\n` +
        `  多半是这个 exe 正在运行 —— 先关掉那个黑窗口（或任务管理器结束 物种标注工坊.exe）再打包。`,
    );
  }

  const size = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
  fs.writeFileSync(VERSION_FILE, version + '\n', 'utf8');
  fs.rmSync(BUILD, { recursive: true, force: true });

  /* ---------- 发布物：带版本号的副本 + 更新清单（放 dist/） ----------
   * 主程序留在根目录（它读同级的 data/，接着用现有账号配置）；
   * dist/ 里放的是「要上传的包」，用纯 ASCII 名字，免得 OSS 里的 key 变成一长串 %E7%89%A9…
   */
  const DIST = path.join(ROOT, 'dist');
  fs.mkdirSync(DIST, { recursive: true });
  const versionedName = `tagden-${version}.exe`;
  try {
    fs.copyFileSync(exePath, path.join(DIST, versionedName));
  } catch (err) {
    console.log(`  （带版本号的副本没写出来：${err.message}）`);
  }
  // url 写相对文件名即可：客户端以「清单所在地址」为基准解析，
  // 以后换存储位置或换 CDN 都不用重新打包。
  const manifest = {
    version,
    notes,
    pubDate: new Date().toISOString().slice(0, 10),
    url: versionedName,
    size: fs.statSync(exePath).size,
    sha256: digest,
  };
  fs.writeFileSync(path.join(DIST, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(`完成：${exePath}`);
  console.log(`体积：${size} MB`);
  console.log(`SHA-256  ${digest}`);
  console.log('');
  console.log('发布物（dist/）：');
  console.log(`  ${versionedName}   带版本号的副本，上传这个`);
  console.log('  latest.json           更新清单，上传到同一目录');
  console.log('');
  if (!updateUrl) {
    console.log('  提示：未配置更新源。要启用自动更新，在项目根建 update.json：');
    console.log('        { "url": "https://你的存储桶域名/tagden" }');
    console.log('        然后重新执行 build-exe.js。');
    console.log('');
  }
  console.log('提示：exe 放在本目录时，读的就是现有的 data/（账号不用重填）；');
  console.log('      拷到别的机器上，会在同目录新建空的 data。');
  console.log('');
}

main();
