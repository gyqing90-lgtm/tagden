'use strict';

/**
 * 模型接口（GBIF 中文名补全 / 归纳）的凭据优先级解析。
 *
 * 三个来源，按顺序取：
 *   1. 用户自己在「AI 设置」里填的 Key（存 data/config.json，加密落盘）
 *   2. 程序内置的那一枚（lib/builtin-ds.js，作者提供的免费额度）
 *   3. 都没有 → 空，界面提示用户去填
 *
 * 特意做成纯函数：这段逻辑管着「会不会悄悄烧作者的额度」，
 * 必须有测试锁住，不能只靠起个服务手点一遍。
 *
 * 两个容易被忽略的细节，都写在测试里：
 *   · optOutBuiltin：用户点过「清除 Key」＝ 明确不想用模型补名。这时哪怕内置
 *     Key 还在，也不能回落到内置 —— 否则用户以为关了，其实一直在花别人的额度。
 *   · model：配置里的出厂默认是 deepseek-chat。内置 Key 若是别家（云知声 u2-flash），
 *     拿着云知声的 Key 去问 deepseek-chat 必然 404，所以出厂默认要让位给内置模型名；
 *     但用户自己改过模型就一律听用户的。
 */

/** 出厂默认模型名：只有等于它才视为「用户没改过」 */
const FACTORY_MODEL = 'deepseek-chat';

/**
 * @param {object} o
 * @param {object} o.cfg         data/config.json 里的 deepseek 段
 * @param {object|null} o.builtin 内置 Key 的明文（{apiKey, baseUrl, model}）或 null
 * @param {string} [o.explicitKey]   临时指定的 Key（列模型接口用，不落盘）
 * @param {string} [o.explicitBase]  临时指定的地址
 * @param {string} [o.explicitModel] 临时指定的模型
 * @returns {{apiKey:string, baseUrl:string, model:string, usingBuiltin:boolean, userKey:boolean}}
 */
function pick(o = {}) {
  const cfg = o.cfg && typeof o.cfg === 'object' ? o.cfg : {};
  // 内置对象可能是「解开了但 Key 是空白」：这种情况下当成没有，
  // 免得只把地址填进去、Key 却空着，界面显示能用、一点就 401
  const builtin = o.builtin && String(o.builtin.apiKey || '').trim() ? o.builtin : null;

  const ownKey = String(o.explicitKey || cfg.apiKey || '').trim();
  const userKey = Boolean(ownKey);
  const optedOut = cfg.optOutBuiltin === true;
  // 有主就用主的；用户明确关掉就用不成；否则才轮到内置
  const usingBuiltin = Boolean(builtin && !userKey && !optedOut);

  const apiKey = ownKey || (usingBuiltin ? String(builtin.apiKey).trim() : '');

  /* ---- baseUrl ---- */
  const ownBase = String(o.explicitBase != null ? o.explicitBase : cfg.baseUrl || '').trim();
  let baseUrl = ownBase;
  if (!baseUrl && usingBuiltin) baseUrl = String(builtin.baseUrl || '').trim();

  /* ---- model ---- */
  const ownModel = String(o.explicitModel || cfg.model || '').trim();
  let model = ownModel || FACTORY_MODEL;
  if (usingBuiltin) {
    const bm = String(builtin.model || '').trim();
    if (!ownModel) model = bm || FACTORY_MODEL;
    // 用户没动过模型名（还是出厂默认）而内置配的是别家模型 → 采用内置的
    else if (ownModel === FACTORY_MODEL && bm && bm !== FACTORY_MODEL) model = bm;
  }

  return { apiKey, baseUrl, model, usingBuiltin, userKey };
}

module.exports = { pick, FACTORY_MODEL };
