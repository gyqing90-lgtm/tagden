'use strict';

/**
 * 曾经内嵌在种子里的第三方 API Key —— 现在不再随程序分发。
 *
 * 为什么撤：
 *   豆包（火山方舟）和懂鸟（HHOLOVE）都是按次计费的个人额度。种子里烧一把 Key，
 *   等于把额度公开给每一个下载了 exe 的人，谁都能 `strings` 出来刷。
 *   自 v0.9.3 起这两个站点默认「未配置」，用户要用就在「识别 Key」里填自己申请的。
 *
 * 老用户怎么办：
 *   老版本启动时会把种子合并进 config.json，Key 已经落在自己机器上了。
 *   这里只保留 **Key 的 SHA-256 指纹**（不可逆，拿不回原文），启动时对一次：
 *   指纹一致＝这确实是当年种子里那把，清掉；不一致＝用户自己填的，原地不动。
 *   清完打标记（config.seedKeysPurged），之后不再重复扫。
 *
 * 注意：加了新的指纹就得同步 bump 标记名或加迁移分支，否则只清一次的逻辑不会重跑。
 */

/** 站点.字段 → sha256(明文) */
const SEED_KEY_FP = {
  'doubao.apiKey': '0a16fb47f698866db609bc8186fa021d853bac82885cab16898ab655ec6d5fdd',
  'dongniao.apiKey': '584515f70f040b5448adb6c6a14df58e06df8e46ae9f6ab43e3b0d1e454d26e7',
};

const sha256hex = (s) => require('node:crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * 原地清掉命中的内置 Key。
 * @param {object} sites config.sites
 * @returns {string[]} 被清掉的站点（去重，按出现顺序）
 */
function purge(sites) {
  const removed = [];
  if (!sites || typeof sites !== 'object') return removed;
  for (const [slot, fp] of Object.entries(SEED_KEY_FP)) {
    const [site, field] = slot.split('.');
    const acc = sites[site];
    if (!acc || typeof acc !== 'object') continue;
    const cur = acc[field];
    if (!cur || sha256hex(cur) !== fp) continue;
    acc[field] = '';
    if (!removed.includes(site)) removed.push(site);
  }
  return removed;
}

/** 某个站点是否仍然填着内置的那把 Key（诊断包/设置面板想提示时用） */
function stillBundled(site, value) {
  const fp = SEED_KEY_FP[`${site}.apiKey`];
  return !!fp && !!value && sha256hex(value) === fp;
}

module.exports = { SEED_KEY_FP, purge, stillBundled, sha256hex };
