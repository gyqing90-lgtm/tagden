'use strict';
/**
 * 只留最近几版发布物，把老包删掉。
 *
 * 为什么要删：dist/ 里每版一个 110 MB 的 exe，20 版就是 2.2 GB。这个目录在
 * OneDrive 里，每加一版就等于让同步器多搬 100 多 MB，客户端上传/校验也变慢。
 * 而真正还需要留在本机的只有两种：
 *   1. 最近 N 版（默认 3）—— 打增量补丁时当基线用，回滚也够；
 *   2. 指向当前最新版的补丁（* -to-<latest>.patch）—— 老客户端升级要用。
 * 更早的 exe 和「升级到旧版」的补丁没有任何用途。
 *
 *   node tools/prune-dist.js                 真的删，保留最近 3 版
 *   node tools/prune-dist.js --keep 5        保留最近 5 版
 *   node tools/prune-dist.js --dry-run       只打印，不删
 *
 * 只动这些明确的命名，其它文件（latest.json、固定别名的 zip、README…）一律不碰。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MAC = path.join(ROOT, 'dist-mac');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const QUIET = argv.includes('--quiet');
const KEEP = (() => {
  const i = argv.indexOf('--keep');
  const n = i >= 0 ? Number(argv[i + 1]) : 3;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
})();

const HUMAN = (n) =>
  n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`;

/** a.b.c 比较（不走字符串比较，否则 0.9.10 会被判成比 0.9.9 小） */
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function latestVersion(dist) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dist, 'latest.json'), 'utf8'));
    if (j && j.version) return String(j.version);
  } catch {
    /* 没清单就看 dist 里最大的版本号 */
  }
  const vers = fs
    .readdirSync(dist)
    .map((n) => /^tagden-(\d+\.\d+\.\d+)\.exe$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1]);
  return vers.sort(cmpVer).pop() || '';
}

function plan(dirs, keep) {
  const DIST = dirs.dist;
  const MAC = dirs.mac;
  const KEEP = keep;
  const latest = latestVersion(DIST);
  const del = [];

  // ---- Windows：带版本号的 exe ----
  let exeVers = [];
  if (fs.existsSync(DIST)) {
    exeVers = fs
      .readdirSync(DIST)
      .map((n) => /^tagden-(\d+\.\d+\.\d+)\.exe$/.exec(n))
      .filter(Boolean)
      .map((m) => ({ name: m[0], ver: m[1] }))
      .sort((a, b) => cmpVer(b.ver, a.ver));
    exeVers.slice(KEEP).forEach((x) => del.push({ dir: DIST, name: x.name, why: `第 ${KEEP + 1} 版以前` }));
  }

  // ---- Windows：补丁只留「升级到最新版」的 ----
  const maxVer = latest || (exeVers[0] && exeVers[0].ver) || '';
  if (fs.existsSync(DIST)) {
    for (const n of fs.readdirSync(DIST)) {
      const m = /^tagden-(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)\.patch$/.exec(n);
      if (!m) continue;
      const to = m[2];
      if (maxVer && to !== maxVer) {
        del.push({ dir: DIST, name: n, why: `升到旧版 ${to}` });
      }
      // 「从很早的版本升到最新」的补丁：起点 exe 已经不在了，但老客户端还要用它，
      // 而且只有几百 KB，全部保留。
    }
  }

  // ---- macOS：只留最近 N 个 main-x.y.z.js ----
  if (fs.existsSync(MAC)) {
    fs.readdirSync(MAC)
      .map((n) => /^main-(\d+\.\d+\.\d+)\.js$/.exec(n))
      .filter(Boolean)
      .map((m) => ({ name: m[0], ver: m[1] }))
      .sort((a, b) => cmpVer(b.ver, a.ver))
      .slice(KEEP)
      .forEach((x) => del.push({ dir: MAC, name: x.name, why: `第 ${KEEP + 1} 版以前（mac）` }));
  }

  return { latest: maxVer, del };
}

function main() {
  const { latest, del } = plan({ dist: DIST, mac: MAC }, KEEP);
  if (!del.length) {
    if (!QUIET) console.log(`  dist 已经是干净的（最新 ${latest || '?'}，保留 ${KEEP} 版）`);
    return;
  }
  let freed = 0;
  const byDir = new Map();
  for (const d of del) {
    const full = path.join(d.dir, d.name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    freed += size;
    const key = path.basename(d.dir);
    if (!byDir.has(key)) byDir.set(key, { n: 0, bytes: 0 });
    const acc = byDir.get(key);
    acc.n += 1;
    acc.bytes += size;
    if (!DRY) {
      try {
        fs.unlinkSync(full);
      } catch (err) {
        console.log(`  [!!] 删不掉 ${d.name}：${err.message}`);
      }
    }
  }
  if (QUIET && !DRY) {
    console.log(`  已清理 ${del.length} 个旧发布物，释放 ${HUMAN(freed)}（保留最近 ${KEEP} 版，最新 ${latest}）`);
    return;
  }
  for (const [dir, acc] of byDir) {
    console.log(`  ${dir}/  ${acc.n} 个文件  ${HUMAN(acc.bytes)}`);
  }
  console.log('');
  console.log(
    `  ${DRY ? '将删除' : '已删除'} ${del.length} 个旧发布物，${DRY ? '可释放' : '释放'} ${HUMAN(freed)}` +
      `（保留最近 ${KEEP} 版 + 全部 *-to-${latest}.patch）`,
  );
  if (DRY) {
    console.log('');
    for (const d of del.slice(0, 12)) console.log(`    - ${path.basename(d.dir)}/${d.name}  (${d.why})`);
    if (del.length > 12) console.log(`    … 另有 ${del.length - 12} 个`);
  }
}

if (require.main === module) main();

module.exports = { cmpVer, plan, latestVersion };
