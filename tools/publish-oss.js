'use strict';
/**
 * 把发布产物推到阿里云 OSS（零依赖，用官方 V1 签名）。
 *
 *   node tools/publish-oss.js              上传 dist/latest.json + 清单里那只 exe
 *   node tools/publish-oss.js --with-mac   连 mac 的安装包 / 更新包 / latest-mac.json 一起传
 *   node tools/publish-oss.js --manifest-only
 *                                          只补清单（改了 notes.txt 但程序没变时用，
 *                                          省掉 80MB 的重复上传；sha256 仍会核对）
 *   node tools/publish-oss.js --dry-run    只校验配置与文件，不发请求
 *   node tools/publish-oss.js --verify     上传后再回读核对一遍
 *   node tools/publish-oss.js --config ~/.tagden/oss.config.json
 *                                          指定仓库外的 OSS 凭据文件
 *
 * 和聚合台那个脚本的关键差别：**所有 key 都带 tagden/ 前缀**。
 * 两个程序共用同一个桶，聚合台的 latest.json 在根目录，混在一起会让
 * 对方的更新器读到错的版本。
 *
 * 另外每次都会维护两个「固定别名」：
 *   tagden/tagden-win.exe     永远指向最新 Windows 版
 *   tagden/tagden-mac-*.zip   本来就是固定名
 * 这样发在微信群里的那段下载文案写一次就够了，不用每发一版就去改群消息。
 *
 * 配置来源：字段级环境变量 > --config > OSS_CONFIG > ~/.tagden/oss.config.json > 项目根旧文件（仅兼容）
 *   （跟聚合台共用桶；凭据请各自放在 ~/.tagden/oss.config.json 或用 OSS_* 环境变量）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const updateSign = require('../lib/update-sign');
const { resolvePublicKey, fingerprint } = require('../build/signing');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MAC_DIST = path.join(ROOT, 'dist-mac');
// 配置优先级：--config > OSS_CONFIG > ~/.tagden/oss.config.json > 项目根（旧位置，仅兼容）
const HOME_CFG = path.join(os.homedir(), '.tagden', 'oss.config.json');
const CFG_FILES = [HOME_CFG, path.join(ROOT, 'oss.config.json')];

/** OSS 上的目录前缀：本程序的发布物都在 tagden/ 下 */
const PREFIX = 'tagden/';
/** Windows 包的固定别名：群发文案里只贴这一个，永远是最新版 */
const STABLE_WIN = 'tagden-win.exe';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERIFY = argv.includes('--verify');
const WITH_MAC = argv.includes('--with-mac');
const MANIFEST_ONLY = argv.includes('--manifest-only');
const CONFIG_ARG = (() => {
  const i = argv.indexOf('--config');
  return i >= 0 && argv[i + 1] ? path.resolve(ROOT, argv[i + 1]) : '';
})();

/**
 * 发布前验签：项目里配了 update-pubkey.pem 就要求两个清单都带有效签名，
 * 没配时按旧流程上传（会打警告）。这样「忘了签名」不会悄悄发出去。
 */
const PUB_KEY = resolvePublicKey(ROOT, argv);
function assertManifestSigned(manifest, label) {
  if (PUB_KEY) {
    const fp = fingerprint(PUB_KEY);
    if (!manifest.keyId) {
      throw new Error(`${label} 没有 keyId，说明这个包不是用当前公钥构建的；请先重新打包（客户端会没有内置公钥）`);
    }
    if (manifest.keyId !== fp) {
      throw new Error(`${label} keyId ${manifest.keyId} 与当前公钥 ${fp} 不一致；请用同一把公钥重新打包`);
    }
  }
  if (!manifest.signature) {
    if (PUB_KEY) throw new Error(`${label} 没有 signature，拒绝上传；先跑 node tools/sign-manifest.js`);
    console.log(`  [!!] ${label} 没有签名（项目根没有 update-pubkey.pem，按旧流程上传）`);
    return;
  }
  const r = updateSign.verify(manifest, PUB_KEY);
  if (!r.ok) throw new Error(`${label} 签名校验失败：${r.reason}`);
  if (Array.isArray(manifest.deltas) && manifest.deltas.length) {
    const d = updateSign.verifyDeltas(manifest, PUB_KEY);
    if (!d.ok) throw new Error(`${label} 增量补丁签名校验失败：${d.reason}`);
  }
  console.log(`  [ok] ${label} 签名有效（公钥 ${fingerprint(PUB_KEY)}）`);
}

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.patch': 'application/octet-stream',
};

function loadConfig() {
  let file = {};
  let from = '';
  const files = [CONFIG_ARG, process.env.OSS_CONFIG || '', ...CFG_FILES].filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      file = JSON.parse(fs.readFileSync(f, 'utf8'));
      from = f;
      break;
    } catch (err) {
      throw new Error(`${f} 不是合法 JSON：${err.message}`);
    }
  }
  const pick = (envKey, fileKey) => String(process.env[envKey] || file[fileKey] || '').trim();

  let region = pick('OSS_REGION', 'region');
  if (region && !/^oss-/.test(region)) region = `oss-${region}`;

  const cfg = {
    bucket: pick('OSS_BUCKET', 'bucket'),
    region,
    akId: pick('OSS_AK_ID', 'akId'),
    akSecret: pick('OSS_AK_SECRET', 'akSecret'),
    endpoint: pick('OSS_ENDPOINT', 'endpoint'), // 仅调试用
    from,
  };

  const missing = [];
  if (!cfg.bucket) missing.push('bucket');
  if (!cfg.region) missing.push('region');
  if (!cfg.akId) missing.push('akId');
  if (!cfg.akSecret) missing.push('akSecret');
  if (missing.length) {
    throw new Error(
      `缺少配置：${missing.join('、')}\n` +
        `  办法一：把配置放到仓库外（推荐）：${HOME_CFG}\n` +
        `    { "bucket": "…", "region": "oss-cn-hangzhou", "akId": "LTAI…", "akSecret": "…" }\n` +
        `  办法二：--config <文件> 或 OSS_CONFIG=<文件>\n` +
        `  办法三：设环境变量 OSS_BUCKET / OSS_REGION / OSS_AK_ID / OSS_AK_SECRET`,
    );
  }
  return cfg;
}

/** OSS V1 签名：VER\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + Resource */
function sign({ akSecret, method, bucket, key, contentType, date, headers }) {
  const canonHeaders = Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith('x-oss-'))
    .sort()
    .map((k) => `${k.toLowerCase()}:${String(headers[k]).trim()}\n`)
    .join('');
  const stringToSign = [method, '', contentType, date, `${canonHeaders}/${bucket}/${key}`].join('\n');
  return {
    signature: crypto.createHmac('sha1', akSecret).update(stringToSign, 'utf8').digest('base64'),
    stringToSign,
  };
}

function target(cfg) {
  const raw = cfg.endpoint || `${cfg.bucket}.${cfg.region}.aliyuncs.com`;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  const insecure = u.protocol === 'http:';
  return {
    secure: !insecure,
    hostname: u.hostname,
    port: u.port || (insecure ? 80 : 443),
    origin: `${u.protocol}//${u.host}`,
  };
}

const base = (cfg) => target(cfg).origin;

const encodeKey = (key) =>
  key
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');

function request(cfg, { method, key, body, contentType, date, extra }) {
  const headers = {
    Date: date,
    'Content-Type': contentType,
    'Content-Length': body ? body.length : 0,
    'x-oss-object-acl': 'public-read',
    ...(extra || {}),
  };
  const { signature } = sign({ akSecret: cfg.akSecret, method, bucket: cfg.bucket, key, contentType, date, headers });
  headers.Authorization = `OSS ${cfg.akId}:${signature}`;

  const t = target(cfg);
  const mod = t.secure ? https : require('node:http');

  return new Promise((resolve, reject) => {
    const req = mod.request(
      { hostname: t.hostname, port: t.port, method, path: `/${encodeKey(key)}`, headers, timeout: 300000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 服务端复制（同桶内秒完，不用再传一遍 80MB）。
 * 老版本 OSS 或权限不足时返回失败，调用方会退回「老实上传」。
 */
async function copyObject(cfg, { fromKey, toKey, contentType }) {
  const res = await request(cfg, {
    method: 'PUT',
    key: toKey,
    body: null,
    contentType,
    date: new Date().toUTCString(),
    extra: {
      'x-oss-copy-source': `/${cfg.bucket}/${encodeKey(fromKey)}`,
      'x-oss-metadata-directive': 'REPLACE',
    },
  });
  return res;
}

function human(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

async function main() {
  const cfg = loadConfig();
  const manifestPath = path.join(DIST, 'latest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('dist/latest.json 不存在，先跑一次 node build-exe.js');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.url) throw new Error('latest.json 里没有 url 字段，请重新打包');
  assertManifestSigned(manifest, 'latest.json');

  const assetName = String(manifest.url).split('/').pop();
  const assetPath = path.join(DIST, assetName);
  if (!fs.existsSync(assetPath)) throw new Error(`清单指向的 ${assetName} 不在 dist/ 里，请重新打包`);

  const buf = fs.readFileSync(assetPath);
  const realSha = crypto.createHash('sha256').update(buf).digest('hex');
  if (realSha !== manifest.sha256) {
    throw new Error(
      `文件与清单对不上：\n  清单 ${manifest.sha256}\n  实际 ${realSha}\n（多半是改了 exe 却没重新生成清单，重新打包即可）`,
    );
  }

  const jobs = [
    { key: PREFIX + assetName, body: buf, type: TYPES['.exe'] },
    { key: PREFIX + 'latest.json', body: fs.readFileSync(manifestPath), type: TYPES['.json'] },
  ];

  // 增量补丁：体积小，跟着清单一起传；清单是最后传的，断网也不会出现「清单指了不存在的 patch」
  for (const d of manifest.deltas || []) {
    const name = path.basename(String(d.url || ''));
    const file = path.join(DIST, name);
    if (!name || !fs.existsSync(file)) throw new Error(`增量补丁缺失：${name || '(空 url)'}`);
    const patchBuf = fs.readFileSync(file);
    const patchSha = crypto.createHash('sha256').update(patchBuf).digest('hex');
    if (patchBuf.length !== Number(d.size) || patchSha !== String(d.sha256 || '').toLowerCase()) {
      throw new Error(`增量补丁与清单不符：${name}`);
    }
    jobs.push({ key: PREFIX + name, body: patchBuf, type: TYPES['.patch'] });
    console.log(`  补丁   ${name}（${(patchBuf.length / 1024).toFixed(0)} KB）`);
  }
  if (MANIFEST_ONLY) {
    // 只补清单：exe 上面已经校验过 sha256，确认线上下来的还是同一份就不用重传
    jobs.shift();
    console.log('  [i] --manifest-only：跳过 exe，只传 latest.json（+ mac 清单）');
  }

  /* ---------- macOS 三个文件（--with-mac） ----------
   * mac 的清单必须叫 latest-mac.json，绝不能叫 latest.json ——
   * 两个平台的清单结构不同，混在一起会让对方的更新器读到错的版本。
   */
  const macFiles = [];
  if (WITH_MAC) {
    const macManifestPath = path.join(MAC_DIST, 'latest-mac.json');
    if (!fs.existsSync(macManifestPath)) throw new Error('dist-mac/latest-mac.json 不存在，先跑 node build-mac.js');
    const mac = JSON.parse(fs.readFileSync(macManifestPath, 'utf8'));
    if (String(mac.version) !== String(manifest.version)) {
      throw new Error(`mac 清单是 v${mac.version}，exe 是 v${manifest.version}，版本号不一致`);
    }
    assertManifestSigned(mac, 'latest-mac.json');
    const macAssetName = String(mac.url || '').split('/').pop();
    const macAsset = path.join(MAC_DIST, macAssetName);
    if (!fs.existsSync(macAsset)) throw new Error(`mac 更新包 ${macAssetName} 不存在`);
    const macBuf = fs.readFileSync(macAsset);
    const macSha = crypto.createHash('sha256').update(macBuf).digest('hex');
    if (macSha !== mac.sha256) throw new Error(`mac 更新包与清单不符：\n  清单 ${mac.sha256}\n  实际 ${macSha}`);

    // 两个架构的首次安装包都传（Apple Silicon 用 arm64，Intel 机型用 x64）
    for (const arch of ['arm64', 'x64']) {
      const zipSrc = path.join(MAC_DIST, `物种标注工坊-mac-${arch}.zip`);
      if (!fs.existsSync(zipSrc)) {
        console.log(`  [i] 没有 mac ${arch} zip，跳过这个架构的首次安装包`);
        continue;
      }
      jobs.push({
        key: `${PREFIX}tagden-mac-${arch}.zip`,
        body: fs.readFileSync(zipSrc),
        type: TYPES['.zip'],
      });
      macFiles.push(`${PREFIX}tagden-mac-${arch}.zip`);
    }
    jobs.push({ key: PREFIX + macAssetName, body: macBuf, type: TYPES['.js'] });
    jobs.push({ key: PREFIX + 'latest-mac.json', body: fs.readFileSync(macManifestPath), type: TYPES['.json'] });
    macFiles.push(PREFIX + macAssetName, PREFIX + 'latest-mac.json');
  }

  // 先传大文件，最后传清单：中途断了线上清单还指向旧版本，不会出现「清单新了包没到」
  jobs.sort((a, b) => (a.key.endsWith('.json') ? 1 : 0) - (b.key.endsWith('.json') ? 1 : 0));

  console.log('');
  console.log(`  存储桶   ${cfg.bucket}${cfg.from ? `（配置来自 ${path.relative(ROOT, cfg.from) || cfg.from}）` : ''}`);
  console.log(`  地域     ${cfg.region}`);
  console.log(`  地址     ${base(cfg)}/${PREFIX}`);
  console.log(`  版本     v${manifest.version}`);
  console.log(`  上传     ${jobs.map((j) => `${j.key}（${human(j.body.length)}）`).join('\n              ')}`);
  console.log(`  别名     ${PREFIX}${STABLE_WIN} → ${assetName}`);
  console.log('');

  if (DRY) {
    console.log('  --dry-run：配置和文件都正常，没有真的上传。');
    console.log('');
    console.log(`  打完包就是这个根地址： ${base(cfg)}/${PREFIX}`);
    return;
  }

  for (const job of jobs) {
    const date = new Date().toUTCString();
    process.stdout.write(`  → ${job.key} (${human(job.body.length)}) … `);
    const res = await request(cfg, { method: 'PUT', key: job.key, body: job.body, contentType: job.type, date });
    if (res.status !== 200) {
      console.log('失败');
      throw new Error(
        `HTTP ${res.status}\n${res.text.slice(0, 600)}\n\n` +
          '  常见原因：AccessKey 不对（403 SignatureDoesNotMatch）、\n' +
          '  桶名或地域写错（404 NoSuchBucket）、没给这个桶的写权限。',
      );
    }
    console.log('ok');
  }

  /* ---------- 固定别名 ---------- */
  if (!MANIFEST_ONLY) {
    process.stdout.write(`  → 别名 ${PREFIX}${STABLE_WIN} … `);
    const cp = await copyObject(cfg, {
      fromKey: PREFIX + assetName,
      toKey: PREFIX + STABLE_WIN,
      contentType: TYPES['.exe'],
    });
    if (cp.status === 200) {
      console.log('ok（服务端复制）');
    } else {
      console.log(`复制失败（HTTP ${cp.status}），改为老实上传一次`);
      const res = await request(cfg, {
        method: 'PUT',
        key: PREFIX + STABLE_WIN,
        body: buf,
        contentType: TYPES['.exe'],
        date: new Date().toUTCString(),
      });
      if (res.status !== 200) throw new Error(`别名上传失败 HTTP ${res.status}\n${res.text.slice(0, 300)}`);
      console.log('  → 别名 ok');
    }
  }

  if (VERIFY) {
    console.log('');
    console.log('  → 回读核对');
    const readJson = async (key) => {
      const r = await request(cfg, { method: 'GET', key, contentType: TYPES['.json'], date: new Date().toUTCString() });
      if (r.status !== 200) throw new Error(`读 ${key} 失败：HTTP ${r.status}`);
      return JSON.parse(r.text);
    };
    const head = async (key, expect) => {
      const r = await request(cfg, { method: 'HEAD', key, contentType: TYPES['.exe'], date: new Date().toUTCString() });
      if (r.status !== 200) throw new Error(`HEAD ${key} 失败：HTTP ${r.status}`);
      const size = Number(r.headers['content-length'] || 0);
      if (expect != null && size !== expect) throw new Error(`${key} 线上 ${size} 与本地 ${expect} 不符`);
      return size;
    };

    const remote = await readJson(PREFIX + 'latest.json');
    if (remote.version !== manifest.version) {
      throw new Error(`线上清单是 v${remote.version}，本地是 v${manifest.version}`);
    }
    const size = await head(PREFIX + assetName, buf.length);
    console.log(`     latest.json v${remote.version} / ${assetName} ${human(size)} 一致`);
    if (!MANIFEST_ONLY) {
      await head(PREFIX + STABLE_WIN, buf.length);
      console.log(`     别名 ${STABLE_WIN} 与 ${assetName} 同大小`);
    }
    if (WITH_MAC) {
      const macRemote = await readJson(PREFIX + 'latest-mac.json');
      if (macRemote.version !== manifest.version) throw new Error(`线上 mac 清单是 v${macRemote.version}`);
      for (const key of macFiles) {
        const local = jobs.find((j) => j.key === key);
        const sz = await head(key, local ? local.body.length : null);
        console.log(`     ${key} ${human(sz)} 一致`);
      }
    }
  }

  console.log('');
  console.log('  发布完成。程序里的更新源应为：');
  console.log(`    ${base(cfg)}/${PREFIX}`);
  console.log('');
  console.log('  群发文案里用固定别名（永远指向最新版）：');
  console.log(`    Windows  ${base(cfg)}/${PREFIX}${STABLE_WIN}`);
  console.log(`    macOS    ${base(cfg)}/${PREFIX}tagden-mac-arm64.zip（M 芯片）`);
  console.log(`             ${base(cfg)}/${PREFIX}tagden-mac-x64.zip（Intel）`);
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error(`  ${err.message}`);
  console.error('');
  process.exitCode = 1;
});
