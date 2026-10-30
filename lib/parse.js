'use strict';

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析采石工（quarryman）结果页：取当前激活的 tab 里的第一张表
 * <tr><td>中文名</td><td><i>Genus</i> <i>species</i></td><td>79.37%</td></tr>
 */
function parseQuarryman(html) {
  // 限定在物种标签页内，避免抓到科/属的表
  const start = html.indexOf('id="species-tabpanel0"');
  const scope = start >= 0 ? html.slice(start, start + 40000) : html;

  const out = [];
  const rowRe = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>\s*([\d.]+)\s*%\s*<\/td>/g;
  let m;
  while ((m = rowRe.exec(scope)) !== null) {
    const cn = stripTags(m[1]);
    const latin = stripTags(m[2]);
    const score = Number(m[3]);
    if (!latin) continue;
    out.push({ cn, latin, score, rank: out.length + 1 });
    if (out.length >= 10) break;
  }
  return out;
}

const SCORE_KEYS = [
  'confidence', 'score', 'probability', 'prob', 'percent', 'percentage',
  'per', 'similarity', 'weight', 'p', 'acc', 'accuracy', 'value',
];
const LATIN_KEYS = [
  'latin', 'scientific_name', 'scientificName', 'sci_name', 'sciName',
  'species', 'taxon_name', 'taxonName', 'name_latin', 'latin_name',
];
const CN_KEYS = [
  'cn', 'namecn', 'name_cn', 'cn_name', 'chinese_name', 'common_name',
  'commonName', 'zh_name', 'preferred_common_name', 'label', 'name',
];

const LATIN_RE = /^[A-Z][a-z]{2,}(\s+[a-z][a-z-]{1,}){0,2}(\s+(sp\.|spp\.|cf\.|aff\.))?$/;

function looksLatin(s) {
  return typeof s === 'string' && LATIN_RE.test(s.trim());
}

function pickScore(obj) {
  for (const k of SCORE_KEYS) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      // 0~1 的归一化概率统一换算成百分比
      return v <= 1 ? v * 100 : v;
    }
    if (typeof v === 'string' && /^[\d.]+%?$/.test(v.trim())) {
      return Number(v.replace('%', ''));
    }
  }
  return null;
}

function pickLatin(obj) {
  for (const k of LATIN_KEYS) {
    if (looksLatin(obj[k])) return obj[k].trim();
  }
  if (obj.taxon && typeof obj.taxon === 'object') {
    for (const k of LATIN_KEYS) {
      if (looksLatin(obj.taxon[k])) return obj.taxon[k].trim();
    }
    if (looksLatin(obj.taxon.name)) return obj.taxon.name.trim();
  }
  return null;
}

function pickCn(obj) {
  const latin = pickLatin(obj);
  for (const k of CN_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() && v.trim() !== latin && !looksLatin(v)) return v.trim();
  }
  if (obj.taxon && typeof obj.taxon === 'object') {
    for (const k of CN_KEYS) {
      const v = obj.taxon[k];
      if (typeof v === 'string' && v.trim() && v.trim() !== latin && !looksLatin(v)) return v.trim();
    }
  }
  return '';
}

/**
 * 通用兜底解析：递归遍历未知结构的 JSON，抽出「学名 + 置信度」对象。
 * 用于多识这类接口结构会变动、且没有文档的站点。
 */
function extractCandidates(json, limit = 10) {
  const found = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > 8 || found.length > 400) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const score = pickScore(node);
    const latin = pickLatin(node);
    if (latin && score !== null) {
      const key = latin.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ latin, cn: pickCn(node), score: Math.max(0, Math.min(100, score)) });
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(json, 0);
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, limit).map((it, i) => ({ ...it, rank: i + 1 }));
}

/**
 * 多识（duoshi）专用解析：
 * [{ box, predictor_result: { candidates: [{ chinese_name, scientific_name, probability, rank_label, family }] } }]
 */
function parseDuoshi(json, limit = 10) {
  const boxes = Array.isArray(json) ? json : [];
  const out = [];
  const seen = new Set();
  for (const box of boxes) {
    const cands = box?.predictor_result?.candidates || [];
    for (const c of cands) {
      let latin = (c.scientific_name || c.name || '').trim();
      if (latin.includes('/')) latin = latin.split('/').pop().trim();
      if (!latin || seen.has(latin.toLowerCase())) continue;
      seen.add(latin.toLowerCase());
      out.push({
        latin,
        cn: c.chinese_name || c.species?.chinese_name || '',
        score: Math.round((Number(c.probability) || 0) * 1000) / 10,
        rankLabel: c.rank_label || '',
        family: c.family?.chinese_name || '',
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map((it, i) => ({ ...it, rank: i + 1 }));
}

module.exports = { parseQuarryman, parseDuoshi, extractCandidates, stripTags, looksLatin };
