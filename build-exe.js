'use strict';

/**
 * 打包脚本：把源码 + 网页资源 + Node 运行时合成单个 exe。
 *
 *   node build-exe.js                 补丁号 +1
 *   node build-exe.js 0.4.2           指定版本
 *   node build-exe.js --bump minor    递增次版本号
 *   node build-exe.js --out dist      换个输出目录
 *   node build-exe.js --win-runtime .cache/node-win-x64/node.exe
 *                                     在 mac / linux 上交叉打 Windows exe（运行时版本必须同当前 node）
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
const { execFileSync, execSync } = require('node:child_process');
const { buildBundle, SEA_ASSETS } = require('./build/bundle');
const delta = require('./lib/delta');
const { resolvePublicKey, fingerprint } = require('./build/signing');

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

/**
 * 打包用的运行时：正常就是当前这个 node（Windows 上跑脚本时的 process.execPath）。
 * 在 mac / linux 上交叉打 Windows exe 时，得另给一份 node.exe：
 *   --win-runtime <路径>  >  环境变量 TAGDEN_WIN_RUNTIME  >  .cache/node-win-x64/node.exe
 * SEA 的 blob 和运行时必须是同一个 node 版本，版本不一致注入出来也是废的，所以下面会核对。
 */
function resolveRuntime(argv) {
  const idx = argv.indexOf('--win-runtime');
  const explicit = (idx >= 0 && argv[idx + 1]) || process.env.TAGDEN_WIN_RUNTIME || '';
  const local = path.join(ROOT, '.cache', 'node-win-x64', 'node.exe');
  let rt = '';
  if (explicit) rt = path.resolve(ROOT, explicit);
  else if (process.platform === 'win32') rt = process.execPath;
  else if (fs.existsSync(local)) rt = local;

  if (!rt || !fs.existsSync(rt)) {
    throw new Error(
      `在 ${process.platform} 上打 Windows exe 需要一份 node.exe：\n` +
        `  下载 https://nodejs.org/dist/v${process.versions.node}/win-x64/node.exe\n` +
        `  放到 .cache/node-win-x64/node.exe，或用 --win-runtime <路径> 指定。`,
    );
  }

  const buf = fs.readFileSync(rt);
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`${rt} 不是 Windows 可执行文件（没有 MZ 头），换一份 node.exe 再来。`);
  }
  if (buf.indexOf(Buffer.from(process.versions.node, 'utf8')) < 0) {
    throw new Error(
      `运行时版本和当前 node（v${process.versions.node}）对不上：\n` +
        `  SEA 的 blob 必须和运行时同版本，请换 v${process.versions.node} 的 win-x64 node.exe。`,
    );
  }
  return rt;
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

/**
 * 可选 Windows Authenticode 签名：配置 TAGDEN_WIN_SIGN_CMD 后，在注入完成、算清单哈希之前签最终 exe。
 * 命令里可用 {exe} 占位；不写占位就把 exe 路径追加到命令末尾。
 * 例：TAGDEN_WIN_SIGN_CMD='signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 <指纹> {exe}'
 * 没配置就照旧输出未签名 exe（SmartScreen 仍会提示）。
 */
function signWindowsExe(file) {
  const cmd = String(process.env.TAGDEN_WIN_SIGN_CMD || '').trim();
  if (!cmd) {
    console.log('  [i] 未配置 TAGDEN_WIN_SIGN_CMD，输出未签名 exe');
    return;
  }
  const quoted = `"${String(file).replace(/"/g, '\\"')}"`;
  const line = cmd.includes('{exe}') ? cmd.split('{exe}').join(quoted) : `${cmd} ${quoted}`;
  console.log('→ Windows Authenticode 签名');
  execSync(line, { stdio: 'inherit', windowsHide: true });
  console.log('  签名完成');
}

function main() {
  const argv = process.argv.slice(2);
  const version = resolveVersion(argv);
  const outDir = resolveOutDir(argv);
  const exePath = path.join(outDir, EXE_NAME);
  const updateUrl = resolveUpdateUrl(argv);
  const notes = resolveNotes(argv);
  const runtimePath = resolveRuntime(argv);
  const updatePublicKey = resolvePublicKey(ROOT, argv);
  const keyId = updatePublicKey ? fingerprint(updatePublicKey) : '';

  console.log(`→ 版本 v${version}${updateUrl ? `，更新源 ${updateUrl}` : '（未配置更新源）'}`);
  if (updatePublicKey) console.log(`→ 更新签名公钥 ${fingerprint(updatePublicKey)}（本版强制验签）`);
  else console.log('→ 未配置 update-pubkey.pem：更新只校验 SHA-256（建议先跑 tools/update-keygen.js）');
  console.log(`→ 输出 ${exePath}`);

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  console.log('→ 生成单文件 JS 包');
  const mainJs = buildBundle(ROOT, {
    name: '物种标注工坊',
    version,
    updateUrl,
    updatePublicKey,
    updatePublicKeyFingerprint: keyId,
    requireSignedUpdates: Boolean(updatePublicKey),
    builtAt: new Date().toISOString(),
  });
  const mainPath = path.join(BUILD, 'main.js');
  fs.writeFileSync(mainPath, mainJs, 'utf8');
  console.log(`  main.js  ${(Buffer.byteLength(mainJs) / 1024).toFixed(1)} KB`);

  // 先只做语法与依赖检查，别等打完 80MB 才发现少了个模块
  console.log('→ 校验打包结果');
  execFileSync(process.execPath, ['--check', mainPath], { stdio: 'inherit' });

  console.log('→ 生成 SEA blob');
  // 大二进制走 SEA 原生 assets：原字节进 blob，不像 base64 那样涨 33%。
  // 只用相对 ROOT 的路径（sea-config.json 在 .build/ 下，绝对路径最省心）
  const seaAssets = {};
  for (const v of SEA_ASSETS) {
    const abs = path.join(ROOT, v.rel);
    if (fs.existsSync(abs)) seaAssets[v.key] = abs;
    else console.log(`  （缺 ${v.rel}，跳过该内置资源）`);
  }
  const seaConfig = {
    main: path.relative(ROOT, mainPath).replace(/\\/g, '/'),
    output: path.relative(ROOT, path.join(BUILD, 'sea-prep.blob')).replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  if (Object.keys(seaAssets).length) seaConfig.assets = seaAssets;
  const seaConfigPath = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');
  runNode(['--experimental-sea-config', seaConfigPath]);

  // 先写临时文件再改名：exe 正在运行时直接覆盖会 EPERM
  const TMP_PATH = path.join(outDir, `~${EXE_NAME}`);
  console.log(`→ 复制 Node 运行时（${path.relative(ROOT, runtimePath) || runtimePath}）`);
  fs.copyFileSync(runtimePath, TMP_PATH);

  console.log('→ 注入 blob');
  if (!fs.existsSync(POSTJECT)) {
    throw new Error('缺少 postject，请先执行：npm install --prefix .build-tools postject');
  }
  const blobSize = fs.statSync(seaConfig.output).size;
  const runtimeSize = fs.statSync(runtimePath).size;

  /* postject 把整个 exe 读进 libpe 的 WASM 堆，堆要涨到七八百 MB；机器一忙
   * 就会偶发 Array buffer allocation failed / Aborted()。同一份输入重跑几次
   * 往往就过了（实测三次失败后连续四次全过），所以这里重试而不是直接放弃。
   * 注意：绝不能像以前那样吞掉异常继续往下走 —— 那样会打出个只有 Node 运行时、
   * 没有程序逻辑的假 exe，体积明显偏小还照样发给用户。 */
  const MAX_TRY = 5;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRY; attempt += 1) {
    if (attempt > 1) {
      console.log(`  注入失败（第 ${attempt - 1} 次），重新复制运行时再试…`);
      fs.rmSync(TMP_PATH, { force: true });
      fs.copyFileSync(runtimePath, TMP_PATH);
    }
    try {
      runNode([POSTJECT, TMP_PATH, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', SENTINEL]);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    fs.rmSync(TMP_PATH, { force: true });
    throw new Error(
      `注入 blob 失败（已重试 ${MAX_TRY} 次）：${(lastErr.message || String(lastErr)).split('\n')[0]}\n` +
        `  blob ${(blobSize / 1048576).toFixed(1)} MB，运行时 ${(runtimeSize / 1048576).toFixed(1)} MB\n` +
        `  多半是内存吃紧 —— 关掉几个占内存的程序再打包；\n` +
        `  另一个已知坑：Node 22.22.2 在 postject 的 WASM 堆上超过约 11 MB 就分配失败，\n` +
        `  换 22.23.2 及以上即可（用那个 node 跑本脚本，blob 与运行时才是同一版本）。`,
    );
  }

  // 双保险：注入成功的话文件一定比运行时大（至少大出 blob 的体积）
  const grew = fs.statSync(TMP_PATH).size - runtimeSize;
  if (grew < blobSize * 0.9) {
    fs.rmSync(TMP_PATH, { force: true });
    throw new Error(`注入后体积只多了 ${grew} 字节，小于 blob 的 ${blobSize} 字节，产物不可信，已中止。`);
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

  // 必须在算 sha256 / 生成增量补丁之前签，否则清单里的哈希会对不上
  signWindowsExe(exePath);

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
    ...(keyId ? { keyId } : {}),
  };

  /* ---------- 增量补丁：给 dist/ 里每一个旧版 exe 生成一份 ----------
   * 客户端只下载几十万字节的 patch，用当前 exe 还原出新 exe。
   * 旧 exe 不在 dist/（比如换了台电脑只带了源码）就跳过，客户端自动回退完整包。
   */
  const oldExes = fs.readdirSync(DIST)
    .map((n) => /^tagden-(\d+\.\d+\.\d+)\.exe$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ name: m[0], from: m[1] }))
    .filter((x) => x.from !== version);
  if (oldExes.length) {
    const newBuf = fs.readFileSync(exePath);
    const deltas = [];
    for (const old of oldExes) {
      try {
        const oldBuf = fs.readFileSync(path.join(DIST, old.name));
        const patch = delta.createPatch(oldBuf, newBuf);
        if (patch.length >= newBuf.length * 0.8) {
          console.log(`  [i] ${old.from} → ${version} 变化太大，跳过增量补丁`);
          continue;
        }
        const patchName = `tagden-${old.from}-to-${version}.patch`;
        fs.writeFileSync(path.join(DIST, patchName), patch);
        deltas.push({
          from: old.from,
          url: patchName,
          size: patch.length,
          sha256: crypto.createHash('sha256').update(patch).digest('hex'),
          baseSha256: crypto.createHash('sha256').update(oldBuf).digest('hex'),
          resultSha256: digest,
        });
        console.log(`  补丁 ${old.from} → ${version}  ${(patch.length / 1024).toFixed(0)} KB`);
      } catch (err) {
        console.log(`  [!!] ${old.from} → ${version} 生成补丁失败（不影响完整包）：${err.message}`);
      }
    }
    if (deltas.length) manifest.deltas = deltas;
  }
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
