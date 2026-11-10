#!/usr/bin/env node
'use strict';

/**
 * 站点 canary：用固定图片逐个跑识别站点，尽早发现「接口改版 / 账号失效 / 登录态过期」。
 *
 *   node tools/canary.js                 # 默认免费站点，读本机 data/config.json（或内置种子）
 *   node tools/canary.js --strict        # 还要求 expectedSites 的 Top5 命中预期物种
 *   node tools/canary.js --all           # 连付费/可选站点一起跑（会消耗额度）
 *   node tools/canary.js --sites quarryman,iplant
 *   node tools/canary.js --json canary-report.json
 *   node tools/canary.js --self-test     # 只检查素材/站点表，不联网（CI 用）
 *   node tools/canary.js --dry-run       # 只打印将要跑的任务
 *
 * 凭据优先级：TAGDEN_CANARY_CONFIG（JSON 内容）> --config 文件 > data/config.json > lib/seed.js
 * 输出不打印密钥；report 里只有站点、耗时、Top1 和错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const secure = require('../lib/secure');
const { Sites, SITE_META } = require('../lib/adapters');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'canary');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

function readImages() {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
  const wanted = argOf('--images')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return manifest.images
    .filter((img) => !wanted.length || wanted.includes(img.id))
    .map((img) => ({
      ...img,
      buffer: fs.readFileSync(path.join(FIXTURES, img.file)),
      small: fs.readFileSync(path.join(FIXTURES, img.small)),
      jpeg: fs.readFileSync(path.join(FIXTURES, img.jpeg)),
    }));
}

function loadConfig() {
  const env = String(process.env.TAGDEN_CANARY_CONFIG || '').trim();
  if (env) {
    let parsed;
    try {
      parsed = JSON.parse(env);
    } catch (err) {
      throw new Error(`TAGDEN_CANARY_CONFIG 不是合法 JSON：${err.message}`);
    }
    return { config: parsed, source: 'TAGDEN_CANARY_CONFIG' };
  }

  const file = argOf('--config') || path.join(process.env.TAGDEN_DATA || path.join(ROOT, 'data'), 'config.json');
  if (fs.existsSync(file)) {
    const opened = secure.open(fs.readFileSync(file, 'utf8'));
    if (opened.ok) return { config: opened.value, source: file };
    console.warn(`  [!!] 解不开 ${file}：${opened.error}；改试内置种子`);
  }

  try {
    const seed = require('../lib/seed');
    const opened = secure.open(seed);
    if (opened.ok) return { config: opened.value, source: 'lib/seed.js' };
  } catch {
    /* 没有 seed（例如 CI） */
  }

  throw new Error(
    '没有可用的站点凭据：请设置 TAGDEN_CANARY_CONFIG、--config <文件>，或在有 data/config.json / lib/seed.js 的机器上运行。\n' +
      '只跑免登录站点时可显式用 --sites，例如 --sites quarryman,iplant,butterflyai,butterflyai-butterfly',
  );
}

function selectSites(image, all, only) {
  const groups = new Set([...(image.groups || []), 'general']);
  if (only.length) {
    // --sites 是显式白名单，但仍按类群过滤：拿昆虫站跑植物图只会制造假失败
    return only.filter((k) => SITE_META[k] && groups.has(SITE_META[k].group));
  }
  if (all) {
    return Object.keys(SITE_META).filter((k) => !SITE_META[k].verify && groups.has(SITE_META[k].group));
  }
  return (image.defaultSites || []).filter((k) => SITE_META[k]);
}

function needsCredentials(keys) {
  return keys.some((k) => SITE_META[k] && SITE_META[k].auth !== 'none');
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hitExpected(items, expected) {
  const list = Array.isArray(expected) ? expected : [];
  if (!list.length) return false;
  return (items || []).some((it) => {
    const cn = String(it.cn || '');
    const latin = String(it.latin || '').toLowerCase();
    return list.some((x) => {
      const s = String(x).toLowerCase();
      return (latin && latin.includes(s)) || (cn && cn.includes(x));
    });
  });
}

function fmtTop(top) {
  if (!top) return '—';
  return [top.cn, top.latin].filter(Boolean).join(' ') || '—';
}

async function main() {
  const images = readImages();
  const all = has('--all');
  const strict = has('--strict');
  const jsonPath = argOf('--json');
  const timeoutMs = Math.max(5000, Number(argOf('--timeout', '180000')) || 180000);
  const retries = Math.max(0, Math.min(3, Number(argOf('--retries', '0')) || 0));
  const only = argOf('--sites')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const k of only) {
    if (!SITE_META[k]) throw new Error(`未知站点：${k}`);
  }

  if (has('--self-test')) {
    if (!images.length) throw new Error('没有 canary 图片');
    for (const img of images) {
      if (!img.buffer.length || !img.small.length || !img.jpeg.length) throw new Error(`${img.id} 素材为空`);
      if (!img.defaultSites.length) throw new Error(`${img.id} 没有 defaultSites`);
      for (const k of [...img.defaultSites, ...(img.expectedSites || [])]) {
        if (!SITE_META[k]) throw new Error(`${img.id} 引用了不存在的站点 ${k}`);
      }
    }
    if (Object.keys(SITE_META).length < 20) throw new Error('SITE_META 数量异常');
    console.log(`canary self-test OK：${images.length} 张素材，${Object.keys(SITE_META).length} 个站点`);
    return 0;
  }

  const tasks = [];
  for (const img of images) {
    for (const site of selectSites(img, all, only)) {
      if (!SITE_META[site]) {
        console.warn(`  [!!] 跳过未知站点 ${site}`);
        continue;
      }
      tasks.push({ img, site });
    }
  }
  if (!tasks.length) throw new Error('没有可运行的任务');

  if (has('--dry-run')) {
    console.log(`canary dry-run：${tasks.length} 个任务（未联网）`);
    for (const t of tasks) console.log(`  ${t.img.id} / ${t.site} (${SITE_META[t.site].name})`);
    return 0;
  }

  const keys = [...new Set(tasks.map((t) => t.site))];
  let config = { sites: {} };
  let source = '(免登录站点，无配置)';
  if (needsCredentials(keys)) {
    ({ config, source } = loadConfig());
  }
  const sites = new Sites(config);

  // 登录类站点先统一登一次；失败不中断，让每个站点自己报错
  const loginErrors = [];
  const loginKeys = [...new Set(
    keys
      .filter((k) => SITE_META[k].auth === 'login')
      .map((k) => SITE_META[k].account || k),
  )];
  for (const k of loginKeys) {
    try {
      await withTimeout(sites.login(k), Math.min(timeoutMs, 120000), `登录 ${k}`);
    } catch (err) {
      loginErrors.push({ site: k, error: err.message || String(err) });
      console.warn(`  [!!] 登录 ${k} 失败：${err.message || err}`);
    }
  }

  const results = [];
  for (const t of tasks) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        last = await withTimeout(sites.identify(t.site, {
          buffer: t.img.buffer,
          mime: t.img.mime,
          filename: t.img.file,
          small: t.img.small,
          jpeg: t.img.jpeg,
        }), timeoutMs, `${t.img.id}/${t.site}`);
        if (last && last.ok && Array.isArray(last.items) && last.items.length) break;
      } catch (err) {
        last = { ok: false, items: [], error: err.message || String(err), ms: 0 };
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    }

    const items = Array.isArray(last && last.items) ? last.items : [];
    const top = items[0] || null;
    const expected = (t.img.expectedSites || []).includes(t.site);
    const expectedHit = expected ? hitExpected(items, t.img.expected) : null;
    const ok = Boolean(last && last.ok && items.length);
    results.push({
      image: t.img.id,
      site: t.site,
      ok,
      ms: Number(last && last.ms) || 0,
      top: top ? { cn: top.cn || '', latin: top.latin || '' } : null,
      expected,
      expectedHit,
      error: String((last && last.error) || ''),
    });
    console.log(
      `${ok ? '[OK]  ' : '[FAIL]'} ${t.img.id}/${t.site}  ${String(Number(last && last.ms) || 0).padStart(5)}ms  ` +
        `${fmtTop(top)}${expected ? (expectedHit ? '  (expected ✓)' : '  (expected ✗)') : ''}` +
        `${!ok && last && last.error ? `  ${last.error}` : ''}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  const expectedMiss = results.filter((r) => r.expected && r.expectedHit === false);
  const summary = {
    total: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    expectedMiss: expectedMiss.length,
    images: images.length,
    sites: keys.length,
    configSource: source,
    loginErrors: loginErrors.length,
    at: new Date().toISOString(),
  };

  console.log('');
  console.log(
    `canary: ${summary.ok}/${summary.total} OK，失败 ${summary.failed}，预期未命中 ${summary.expectedMiss}` +
      `（${summary.images} 张素材 / ${summary.sites} 个站点，配置：${source}）`,
  );
  for (const e of loginErrors) console.log(`  登录失败 ${e.site}: ${e.error}`);

  if (jsonPath) {
    const report = { summary, loginErrors, results };
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`报告：${jsonPath}`);
  }

  if (failed.length || (strict && expectedMiss.length)) {
    console.log(strict ? '结果：失败（--strict 也检查预期物种）' : '结果：有站点失败；加 --json 看详情');
    return 1;
  }
  console.log('结果：全部通过');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`canary 失败：${err.message}`);
    process.exit(1);
  });
