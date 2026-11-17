'use strict';

/**
 * 物种名录 → RTF（Word / WPS 双击直接打开，能直接复制进调查报告附录）。
 *
 * 为什么用 RTF 而不是 docx：
 *   docx 是 zip + OOXML，得先打一套 XML；RTF 是纯文本，只靠控制字就能表达
 *   「拉丁名斜体、中文名正体、分级缩进、自动编号」这四件附录最要紧的事。
 *   生成一份几百 KB 的字符串，零依赖，兼容 Word 2003 以来所有版本。
 *
 * 排版约定（报告附录的通行格式）：
 *   一、目中文名  拉丁目名（斜体）
 *     （一）科中文名  拉丁科名（斜体）
 *       1. 种中文名  拉丁学名（斜体）
 *
 * 中文一律转 \uN? 形式：RTF 文件按字节读，直接塞 UTF-8 在中文 Word 里会变乱码，
 * \u 是唯一跨平台稳妥的写法（N 为有符号 16 位，>32767 要减 65536）。
 */

/** RTF 正文转义：保留 ASCII，非 ASCII 转 \uN? */
function rtfEscape(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') {
      out += `\\${ch}`;
    } else if (code === 0x0a) {
      out += '\\line ';
    } else if (code < 0x20) {
      // 其它控制字符丢掉，RTF 里出现会被当控制字
    } else if (code < 0x80) {
      out += ch;
    } else if (code > 0xffff) {
      // 非 BMP（生僻字）：拆成高低两个代理码元，Word 才认
      for (let i = 0; i < ch.length; i += 1) {
        const unit = ch.charCodeAt(i);
        out += `\\u${unit > 32767 ? unit - 65536 : unit}?`;
      }
    } else {
      out += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return out;
}

/** 中文段落（字体 f0） */
const cn = (text) => `\\f0 ${rtfEscape(text)}`;
/** 拉丁段落（字体 f1 + 斜体）—— 属名种名必须斜体，这是分类学写作的硬规矩 */
const latin = (text) => (text ? `\\f1\\i ${rtfEscape(text)}\\i0\\f0 ` : '');

/**
 * 归组：目 → 科 → 种。空分类统一收进「分类待定」，不让它们散在正常名录里。
 * 排序按拉丁名（没有拉丁名再按中文），保证每次导出顺序一致。
 */
function groupSpecies(species) {
  const orders = new Map();
  for (const s of species || []) {
    const oKey = s.order || s.orderCn || '';
    const oLabel = { cn: s.orderCn || '', latin: s.order || '' };
    let order = orders.get(oKey);
    if (!order) {
      order = { ...oLabel, key: oKey, families: new Map() };
      orders.set(oKey, order);
    }
    const fKey = s.family || s.familyCn || '';
    let family = order.families.get(fKey);
    if (!family) {
      family = { cn: s.familyCn || '', latin: s.family || '', species: [] };
      order.families.set(fKey, family);
    }
    family.species.push(s);
  }

  const byName = (a, b) => {
    const x = a.latin || a.cn || '';
    const y = b.latin || b.cn || '';
    return x.localeCompare(y, 'en');
  };

  const list = [...orders.values()];
  for (const o of list) {
    o.familyList = [...o.families.values()].sort(byName);
    for (const f of o.familyList) f.species.sort(byName);
  }
  list.sort((a, b) => {
    // 「分类待定」永远排最后：有 key 的记 0，没 key 的记 1，升序即可
    const ax = a.key ? 0 : 1;
    const bx = b.key ? 0 : 1;
    if (ax !== bx) return ax - bx;
    return byName(a, b);
  });
  return list;
}

/** 中文数字：附录里的「一、」「（一）」用它，超过 20 个就退回阿拉伯数字 */
function cnNum(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n <= 10) return d[n];
  if (n < 20) return `十${d[n - 10]}`;
  return String(n);
}

/**
 * 生成 RTF 全文。
 * @param {object} opt
 * @param {Array} opt.species  [{cn, latin, orderCn, order, familyCn, family, n}]
 * @param {string} [opt.title] 标题，默认「物种名录」
 * @param {string} [opt.note]  标题下的一行说明
 * @param {Date}   [opt.at]    生成时间
 * @returns {string}
 */
function buildRtf({ species, title = '物种名录', note = '', at = new Date() } = {}) {
  const list = groupSpecies(species);
  const totalSpecies = (species || []).length;
  // 只统计「查得到名字」的目和科：分类待定那一组既不算目、也不能凑进科数
  const known = list.filter((o) => o.key);
  const totalOrder = known.length;
  const totalFamily = known.reduce((n, o) => n + o.familyList.filter((f) => f.latin || f.cn).length, 0);
  const knownSpecies = known.reduce((n, o) => n + o.familyList.reduce((m, f) => m + f.species.length, 0), 0);
  const unknownSpecies = totalSpecies - knownSpecies;

  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const lines = [];

  lines.push('{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat');
  // 中文字体给 SimSun（Windows 一定有；macOS Word 会映射到宋体），拉丁用 Times New Roman
  lines.push('{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}{\\f1\\froman\\fcharset0 Times New Roman;}}');
  lines.push('\\viewkind4\\uc1');

  // 标题：居中、加粗；下面一行是统计口径
  lines.push(`\\pard\\qc\\sa160\\b\\f0\\fs36 ${rtfEscape(title)}\\b0`);
  lines.push(
    `\\pard\\qc\\sa240\\f0\\fs20 ${rtfEscape(
      `共 ${totalOrder} 目 ${totalFamily} 科 ${totalSpecies} 种 · ${stamp}` +
        (unknownSpecies > 0 ? `（其中 ${unknownSpecies} 种未查到分类）` : ''),
    )}`,
  );

  if (note) lines.push(`\\pard\\qc\\sa240\\f0\\fs18 ${rtfEscape(note)}`);

  if (!totalSpecies) {
    lines.push(`\\pard\\sa120\\f0\\fs22 ${rtfEscape('（还没有已鉴定的物种）')}`);
  }

  let seq = 0;
  list.forEach((order, oi) => {
    const orderHead = order.key
      ? `\\pard\\sb240\\sa120\\f0\\fs26\\b ${rtfEscape(`${cnNum(oi + 1)}、`)}${cn(order.cn || order.latin)}  ${latin(order.latin)}\\b0`
      : `\\pard\\sb240\\sa120\\f0\\fs26\\b ${rtfEscape('分类待定')}\\b0`;
    lines.push(orderHead);

    order.familyList.forEach((family, fi) => {
      const famHead = family.latin || family.cn
        ? `\\pard\\li360\\sa80\\f0\\fs22\\b ${rtfEscape(`（${cnNum(fi + 1)}）`)}${cn(family.cn || family.latin)}  ${latin(family.latin)}\\b0`
        : `\\pard\\li360\\sa80\\f0\\fs22\\b ${rtfEscape('（科未定）')}\\b0`;
      lines.push(famHead);

      for (const s of family.species) {
        seq += 1;
        const nameCn = s.cn || '';
        const nameLatin = s.latin || '';
        let body = `\\pard\\li720\\sa40\\f0\\fs22 ${rtfEscape(`${seq}. `)}`;
        if (nameCn) body += `${cn(nameCn)}  `;
        if (nameLatin) body += latin(nameLatin);
        lines.push(body.trimEnd());
      }
    });
  });

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

module.exports = { buildRtf, groupSpecies, rtfEscape, cnNum };
