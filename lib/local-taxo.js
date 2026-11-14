'use strict';
/**
 * local-taxo.js — 本地物种名录（学名 → 界/门/纲/目/科/属 + 各阶元中文名）
 *
 * 为什么要有它：归档和统计都要把照片按分类层级分文件夹，旧做法是拿学名去
 * iNaturalist / GBIF 查。图上万张时这一步又慢又要联网，断网就全掉进「未分类」。
 * 用户手上有 Chinese-Latin（OneDrive 里那份 backbone 数据库，774 万行，
 * 每行自带 kingdom…genus 与中文名），本机读它比联网快几百倍，而且完全离线。
 *
 * 取数：
 *   backbone_中文.sqlite 的 taxon 表（canonicalName 有索引）：
 *     · 学名 → 一行 kingdom/phylum/class/order/family/genus
 *     · 每个阶元名再去同一张表里按 (canonicalName, taxonRank) 取中文名
 *       「凤蝶科 / 鳞翅目 / 昆虫纲 …」都是现成的，不用联网补
 *   node:sqlite 是 Node 22 内置模块，不引第三方依赖，单文件 exe 照样能用。
 *
 * 找不到数据库、没有 node:sqlite、文件损坏 —— 一律静默降级（ok:false），
 * 调用方继续走原来的联网路径，绝不让归档/统计因为本地名录崩掉。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RANKS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];
/** 数据库的候选文件名（用户那套目录里叫 backbone_中文.sqlite） */
const DB_NAMES = ['backbone_中文.sqlite', 'backbone.sqlite', 'backbone_cn.sqlite'];
/** 阶元中文名的进程内记忆（阶元总量远小于物种数，几万条足够） */
const MAX_RANK_CN = 60000;
/** 物种解析结果缓存（一次统计/归档里同一学名只查一次） */
const MAX_MEMO = 200000;

let db = null;
let dbFile = '';
let error = '';
let cfgDir = '';
let stmts = null;
let opened = false;
const rankCn = new Map();
const memo = new Map();

/* ---------------- 找数据库 ---------------- */

/** 常见的 Chinese-Latin 位置：OneDrive 个人/工作账号、家目录、Windows 的 OneDrive */
function guessDirs() {
  const home = os.homedir();
  const out = [];
  const clouds = path.join(home, 'Library', 'CloudStorage');
  try {
    for (const name of fs.readdirSync(clouds)) {
      if (!/^OneDrive/i.test(name)) continue;
      out.push(path.join(clouds, name, 'Chinese-Latin'));
    }
  } catch {}
  out.push(path.join(home, 'Chinese-Latin'));
  out.push(path.join(home, 'OneDrive', 'Chinese-Latin'));
  const up = process.env.USERPROFILE || process.env.HOME || home;
  out.push(path.join(up, 'OneDrive', 'Chinese-Latin'));
  try {
    for (const name of fs.readdirSync(up)) {
      if (/^OneDrive/i.test(name)) out.push(path.join(up, name, 'Chinese-Latin'));
    }
  } catch {}
  return out;
}

function dbIn(dir) {
  if (!dir) return '';
  try {
    const st = fs.statSync(dir);
    if (st.isFile()) return dir;
    if (!st.isDirectory()) return '';
  } catch {
    return '';
  }
  for (const name of DB_NAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return '';
}

function findDb() {
  const explicit = String(process.env.TAGDEN_LOCAL_TAXO || '').trim();
  for (const d of [cfgDir, explicit]) {
    const p = dbIn(d);
    if (p) return p;
  }
  for (const d of guessDirs()) {
    const p = dbIn(d);
    if (p) return p;
  }
  return '';
}

/* ---------------- 打开 ---------------- */

function close() {
  try {
    if (db) db.close();
  } catch {}
  db = null;
  stmts = null;
  opened = false;
  dbFile = '';
  error = '';
  rankCn.clear();
  memo.clear();
}

function open() {
  opened = true;
  dbFile = findDb();
  if (!dbFile) {
    error = '没找到 backbone 数据库（可指定 Chinese-Latin 文件夹）';
    return;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    error = '当前 Node 不支持 node:sqlite（需要 22+）';
    return;
  }
  try {
    const st = fs.statSync(dbFile);
    if (!st.size) {
      error = '数据库是空的（可能在 OneDrive 上还没下载到本地）';
      return;
    }
    db = new DatabaseSync(dbFile, { readOnly: true });
    stmts = {
      byName: db.prepare(
        'SELECT canonicalName, taxonRank, kingdom, phylum, class, "order", family, genus, 中文名'
          + ' FROM taxon WHERE canonicalName = ? LIMIT 40',
      ),
      byCn: db.prepare(
        'SELECT canonicalName, taxonRank, kingdom, phylum, class, "order", family, genus, 中文名'
          + " FROM taxon WHERE 中文名 = ? AND taxonRank IN ('species','subspecies','variety','form','genus','family') LIMIT 60",
      ),
      rankCn: db.prepare('SELECT 中文名 FROM taxon WHERE canonicalName = ? AND taxonRank = ? LIMIT 1'),
    };
    error = '';
  } catch (err) {
    db = null;
    stmts = null;
    error = '打不开数据库：' + (err && err.message ? err.message : err);
  }
}

/**
 * 初始化。opts.dir 是用户在界面上指定的 Chinese-Latin 文件夹（可为空 = 自动找）。
 * 换目录会关掉旧的再开。
 *
 * 注意：这里**不主动打开数据库**。OneDrive 上的 2.6 GB 文件有可能还是「仅云端」，
 * 一打开就会触发整包下载 —— 等真正要解析分类（或界面查状态）时再开。
 */
function init(opts = {}) {
  const dir = String((opts && opts.dir) || '').trim();
  if (dir !== cfgDir) {
    cfgDir = dir;
    close();
  }
  return { ok: Boolean(db), dir: cfgDir, dbFile, error, size: 0 };
}

function status() {
  if (!opened) open();
  return {
    ok: Boolean(db),
    dir: cfgDir,
    dbFile,
    error,
    size: (() => {
      try {
        return fs.statSync(dbFile).size;
      } catch {
        return 0;
      }
    })(),
  };
}

/* ---------------- 名字归一 ---------------- */

/** 首字母大写、其余小写（名录里 canonicalName 就是这么存的） */
function capWord(w) {
  const s = String(w || '');
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * 学名 → 依次尝试的写法：原名、二名法、属名。
 * 图上写的是「Papilio bianor Cramer, 1777」「Papilio (Achillides) bianor」这类，
 * 名录里只存「Papilio bianor」，所以要削成二名法再查。
 */
function nameVariants(latin) {
  const out = [];
  const raw = String(latin || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[,_;].*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return out;
  const words = raw.split(' ').filter((w) => /^[A-Za-z][A-Za-z-]*$/.test(w));
  if (!words.length) return out;
  const full = capWord(words[0]) + (words[1] ? ' ' + words[1].toLowerCase() : '');
  if (full) out.push(full);
  if (words.length >= 3) out.push(capWord(words[0]) + ' ' + words[1].toLowerCase());
  if (words[0]) out.push(capWord(words[0]));
  return [...new Set(out)];
}

/* ---------------- 行 → ranks ---------------- */

function cnOfRank(rank, latin) {
  const key = `${rank}:${String(latin).toLowerCase()}`;
  if (rankCn.has(key)) return rankCn.get(key);
  let cn = '';
  try {
    const row = stmts.rankCn.get(latin, rank);
    if (row && row['中文名']) cn = String(row['中文名']).trim();
  } catch {}
  if (rankCn.size < MAX_RANK_CN) rankCn.set(key, cn);
  return cn;
}

/** 从候选行里挑信息最全的一行（优先种级、阶元齐全） */
function pickRow(rows) {
  let best = null;
  let bestScore = -1;
  for (const r of rows || []) {
    let score = 0;
    for (const k of RANKS) if (r && r[k]) score += 1;
    if (r && r['中文名']) score += 2;
    const rank = String((r && r.taxonRank) || '').toLowerCase();
    if (rank === 'species' || rank === 'subspecies' || rank === 'variety' || rank === 'form') score += 2;
    else if (rank === 'genus') score += 1;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

function ranksOf(row) {
  if (!row) return null;
  const ranks = {};
  for (const r of RANKS) {
    const latin = String(row[r] || '').trim();
    if (!latin) continue;
    ranks[r] = { latin, cn: cnOfRank(r, latin) };
  }
  if (!ranks.genus && !ranks.family) return null;
  return ranks;
}

/* ---------------- 对外：解析 ---------------- */

function byLatin(latin) {
  for (const name of nameVariants(latin)) {
    let rows = [];
    try {
      rows = stmts.byName.all(name);
    } catch {
      rows = [];
    }
    const ranks = ranksOf(pickRow(rows));
    if (ranks) return ranks;
  }
  return null;
}

/**
 * 只有中文名时：名录里同一个中文名可能挂多个属（重名），
 * 只有当所有候选都落在同一个属里才认，否则宁可不认交给联网。
 */
function byCn(cn) {
  const want = String(cn || '').trim();
  if (!want) return null;
  let rows = [];
  try {
    rows = stmts.byCn.all(want);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const genera = new Set();
  for (const r of rows) {
    if (r && r.genus) genera.add(String(r.genus).toLowerCase());
  }
  if (!genera.size) return null;
  if (genera.size > 1) return null;
  const same = rows.filter((r) => r && String(r.genus || '').toLowerCase() === [...genera][0]);
  return ranksOf(pickRow(same));
}

/**
 * 解析一个名字。latin 优先，没有学名才用中文名。
 * 命中返回 { kingdom:{latin,cn}, …, genus:{latin,cn} }；没命中返回 null。
 * 永远不会抛错。
 */
function resolve(latin, cn) {
  if (!opened) open();
  if (!db || !stmts) return null;
  const l = String(latin || '').trim();
  const c = String(cn || '').trim();
  if (!l && !c) return null;
  const key = l ? `l:${l.toLowerCase()}` : `c:${c}`;
  if (memo.has(key)) return memo.get(key);
  let out = null;
  try {
    out = l ? byLatin(l) : byCn(c);
    // 只有中文名命中、或者学名没命中时，再拿中文名兜一次（名录中文名覆盖 137 万条）
    if (!out && c) out = byCn(c);
  } catch {
    out = null;
  }
  if (memo.size < MAX_MEMO) memo.set(key, out);
  return out;
}

module.exports = {
  init,
  status,
  resolve,
  close,
  // 纯函数，导出只为回归测试
  nameVariants,
  RANKS,
};
