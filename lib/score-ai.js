'use strict';
/**
 * 照片评分 · AI 判别（可选增强）
 *
 * 两条路，都不捆绑任何模型、不替用户下载任何东西：
 *   cloud —— 阿里云百炼 DashScope 兼容模式，用户自己去申请 API Key 填进来；
 *             Key 由 lib/secure.js 加密落在 data/score-ai.json，浏览器只拿得到 hasCloudKey。
 *   local —— 运行库（llama-server）已随程序内置，用户只需下载 GGUF 模型与 mmproj，
 *            由 lib/llama.js 拉起；也可以自己起一个服务，在这里填 OpenAI 兼容地址。
 *            本模块只发 HTTP，不管进程。
 *
 * 图片由浏览器 Canvas 压成 JPEG data URL 后传进来（Node 零依赖，解不了 JPEG），
 * 本模块只负责拼提示词、发请求、把模型吐的 JSON 抠出来。
 */

const CLOUD_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const CLOUD_MODELS = [
  { id: 'qwen3-vl-plus', name: 'Qwen3-VL-Plus（推荐·视觉专精）' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus（通用·省配额）' },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max（最强·较贵）' },
];

// 运行库：Windows 随程序内置（lib/llama.js 解压内置 zip）；macOS 用 models/_runtime 里的那份。
const LOCAL_GUIDE = {
  server: 'https://github.com/ggml-org/llama.cpp/releases',
  howto: process.platform === 'win32'
    ? '运行库已内置（llama.cpp · Windows CPU 版），不用再下预编译包；只要下下面任意一个 GGUF 主模型 + 配套 mmproj。点「模型目录」右边的「打开」会直接弹出 models 文件夹，把文件复制进去后点 ↻ 就能选到；也可以直接填完整路径，选好点「启动本地服务」。'
    : 'macOS 不自带运行库：到上面那个 releases 页下一个 llama-bXXXX-bin-macos-arm64.zip，整个解压到 models/_runtime（这一层要能直接看到 llama-server），程序就会自己用它。然后下任意一个 GGUF 主模型 + 配套 mmproj，放进 models 文件夹后点 ↻ 就能选到；选好点「启动本地服务」。',
  example: 'llama-server -m 模型.gguf --mmproj mmproj-F16.gguf --port 8080',
  models: [
    {
      id: 'qwen3vl-4b', name: 'Qwen3-VL-4B（推荐·中文强·8GB 显存可跑）',
      repo: 'unsloth/Qwen3-VL-4B-Instruct-GGUF', size: '约 3.2 GB',
      url: 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF',
    },
    {
      id: 'qwen25vl-3b', name: 'Qwen2.5-VL-3B（轻量·CPU 可跑）',
      repo: 'lmstudio-community/Qwen2.5-VL-3B-Instruct-GGUF', size: '约 3.1 GB',
      url: 'https://huggingface.co/lmstudio-community/Qwen2.5-VL-3B-Instruct-GGUF',
    },
    {
      id: 'qwen3vl-8b', name: 'Qwen3-VL-8B（高质量·12GB+ 显存）',
      repo: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', size: '约 5.9 GB',
      url: 'https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF',
    },
  ],
};

const TAXA = {
  '昆虫': ['昆虫(含蜘蛛等其他节肢动物)',
    '昆虫主体是否可清晰辨认到可用于物种鉴定(考虑主体大小占比、对焦清晰度、姿态角度)'],
  '鸟类': ['鸟类', '鸟体是否可辨认到种级(羽色、体型、喙形、姿态, 有无枝叶遮挡)'],
  '植物': ['植物(花、果、叶或整株)',
    '物种识别关键特征(花冠结构、叶形与叶脉、果实、树皮、整体株型)是否清晰可辨'],
  '兽类': ['兽类(哺乳动物)', '体躯形态、毛色斑纹、头面部特征是否可辨, 有无遮挡'],
  '两栖爬行动物': ['两栖或爬行动物', '皮肤纹理、斑纹、鳞片、体型与头部特征是否清晰可辨'],
  '通用(自动判断)': ['明确的生物主体(动物、植物或真菌等)', '主体是否清晰可辨、特征是否足以判断其类群'],
};

function isInsectTaxon(t) { return String(t || '').includes('昆虫'); }

function buildPrompt(taxon, strict) {
  if (strict && isInsectTaxon(taxon)) {
    return '评分对象: 昆虫。本次评审只针对昆虫, 不要评其他生物。\n'
      + '【专用昆虫检测模式】按昆虫鉴定标准严格判断:\n'
      + '1) 主体是否为昆虫(六足、体分头胸腹)。若画面里是蜘蛛、蜈蚣、马陆、蝎等非昆虫节肢动物, '
      + 'has_subject 仍判为有, 但 subject_kind 必须如实写“蜘蛛/蜈蚣/马陆/蝎”, 不要冒充昆虫。\n'
      + '2) 鉴定关键部位是否清晰: 触角、复眼、足(胫节/跗节)、翅(翅脉/翅斑)、鞘翅与前胸背板、腹部斑纹、'
      + '体表刻点与毛被。至少两处关键部位清晰可辨, 才算 clarity=清晰; 全形清楚但细节糊判为可辨。\n'
      + '3) 构图与背景: 主体占画面比例、遮挡程度、背景杂物干扰。\n'
      + '注意: 白底标本照属于正常拍摄, 背景过曝不扣分; 标本针、标签、比例尺不扣分; 远距离飞行的小点判为模糊。\n'
      + '评分标准: 画面没有昆虫=0~15分; 有但关键部位模糊或严重遮挡=20~35; '
      + '关键部位清晰、可用于鉴定=60~80; 全形与细节都清晰精美=85~100。\n'
      + '只输出一个JSON对象, 不要任何其他文字:\n'
      + '{"has_subject":"有|疑似|无","subject_kind":"画面主体(如 甲虫/蝴蝶/蜘蛛/无)",'
      + '"clarity":"清晰|可辨|模糊","composition":"好|一般|差",'
      + '"key_parts":"清晰可辨的鉴定部位(如 触角+鞘翅+足), 看不清则写 无",'
      + '"score":0到100的整数,"comment":"20字以内中文点评"}';
  }
  const pair = TAXA[taxon] || TAXA['昆虫'];
  return `评分对象: ${pair[0]}。本次评审只针对该对象, 不要评其他生物。\n`
    + '请严格判断以下三点:\n'
    + `1) 画面中是否真的出现了${pair[0]}? 若画面里只有其他生物(例如只有昆虫或只有植物), 必须判为无。\n`
    + `2) ${pair[1]}。\n`
    + '3) 构图与背景。\n'
    + '注意: 白底标本照属于正常拍摄方式, 背景过曝不扣分; 远距离飞行的小点判为模糊。\n'
    + '评分标准: 画面没有该对象=0~15分; 有但难以辨认=20~35; 可辨认鉴定=60~80; 清晰精美=85~100。\n'
    + '只输出一个JSON对象, 不要任何其他文字:\n'
    + '{"has_subject":"有|疑似|无","subject_kind":"画面实际拍到的主要生物(如 甲虫/蝴蝶/树木/无)",'
    + '"clarity":"清晰|可辨|模糊","composition":"好|一般|差","score":0到100的整数,'
    + '"comment":"20字以内中文点评"}';
}

function buildPromptBatch(n, taxon, strict) {
  const body = buildPrompt(taxon, strict).split('\n')
    .filter((ln) => !ln.startsWith('只输出一个JSON') && !ln.trim().startsWith('{"has_subject"'))
    .join('\n').trim();
  return `${body}\n下面按先后顺序给你 ${n} 张图片。请逐张独立评分, 相互之间不要比较、不要参照、`
    + '不要为了拉开差距而调整分数。\n'
    + `必须输出一个长度为 ${n} 的 JSON 数组, 元素顺序与图片顺序严格一致:\n`
    + '[{"idx":1,"has_subject":"有|疑似|无","subject_kind":"画面主体",'
    + '"clarity":"清晰|可辨|模糊","composition":"好|一般|差",'
    + '"key_parts":"清晰可辨的鉴定部位, 看不清写 无",'
    + '"score":0到100的整数,"comment":"20字以内中文点评"}]\n'
    + `只输出这个数组, 长度必须为 ${n}, 不要输出任何解释文字。`;
}

/** 从模型回复里抠 JSON：容错 ```json 围栏、前后解释文字、数组/对象两种形态 */
function parseReply(content, n) {
  let s = String(content || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const arrAt = s.indexOf('['); const objAt = s.indexOf('{');
  let parsed = null;
  const starts = n > 1
    ? [arrAt < 0 ? -1 : arrAt, objAt < 0 ? -1 : objAt].filter((i) => i >= 0)
    : [objAt < 0 ? -1 : objAt, arrAt < 0 ? -1 : arrAt].filter((i) => i >= 0);
  for (const st of starts) {
    const open = s[st];
    const close = open === '[' ? ']' : '}';
    const end = s.lastIndexOf(close);
    if (end <= st) continue;
    try { parsed = JSON.parse(s.slice(st, end + 1)); break; } catch { /* 换下一个起点 */ }
  }
  if (!parsed) return { error: '模型没返回可用的 JSON：' + s.slice(0, 120) };
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return { list: list.slice(0, n).map(normalizeOne) };
}

function normalizeOne(j) {
  if (!j || typeof j !== 'object') return null;
  const num = Math.max(0, Math.min(100, Math.round(Number(j.score) || 0)));
  return {
    has_insect: String(j.has_subject || j.has_insect || ''),
    kind: String(j.subject_kind || '').slice(0, 20),
    clarity: String(j.clarity || ''),
    composition: String(j.composition || ''),
    key_parts: String(j.key_parts || '').slice(0, 40),
    score: num,
    comment: String(j.comment || '').slice(0, 60),
  };
}

function endpoint(cfg, engine) {
  if (engine === 'local') {
    const base = String(cfg.local.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return { error: '本地服务地址要以 http:// 开头' };
    return { url: `${base}/chat/completions`, model: String(cfg.local.model || '').trim() };
  }
  return { url: CLOUD_BASE, model: cfg.cloud.model };
}

/**
 * 跑一批 AI 判别。
 * @param {object} o
 * @param {string} o.engine  cloud | local
 * @param {object} o.cfg     aiPublic() 的结构（不含明文 key）
 * @param {string} o.key     明文云端 Key（只在服务端内存里，绝不回浏览器）
 * @param {Array}  o.images  [{ name, dataUrl }]
 * @param {string} [o.taxon]
 */
async function run(o) {
  const engine = o.engine === 'local' ? 'local' : 'cloud';
  const cfg = o.cfg || {};
  const set = engine === 'local' ? (cfg.local || {}) : (cfg.cloud || {});
  const ep = endpoint(cfg, engine);
  if (ep.error) return { ok: false, error: ep.error };
  if (!ep.model) return { ok: false, error: engine === 'local' ? '请填写本地模型名（llama-server 加载时用的别名）' : '请选择云端模型' };
  if (engine === 'cloud' && !o.key) return { ok: false, error: '还没填云端 API Key，请先在 AI 设置里申请并填写' };

  const images = (o.images || []).filter((im) => im && im.dataUrl);
  if (!images.length) return { ok: false, error: '没有可评的图片' };
  const batch = Math.max(1, Math.min(8, Number(set.batch) || 1));
  const taxon = o.taxon || set.taxon || '昆虫';
  // 专用昆虫检测只对昆虫类群有意义，选了鸟类/植物就静默忽略（提示词层面也不该用昆虫判据）
  const wantStrict = o.strict === undefined || o.strict === null ? !!set.strict : !!o.strict;
  const strict = wantStrict && isInsectTaxon(taxon);
  const headers = { 'content-type': 'application/json' };
  if (engine === 'cloud') headers.authorization = `Bearer ${o.key}`;

  const results = [];
  const errors = [];
  for (let i = 0; i < images.length; i += batch) {
    const group = images.slice(i, i + batch);
    const content = [{ type: 'text', text: group.length > 1 ? buildPromptBatch(group.length, taxon, strict) : buildPrompt(taxon, strict) }];
    for (const im of group) content.push({ type: 'image_url', image_url: { url: im.dataUrl } });
    let resp;
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: ep.model, messages: [{ role: 'user', content }], temperature: 0.1, max_tokens: 1200 }),
        signal: AbortSignal.timeout(150000),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = `${engine === 'local' ? '本地服务' : '云端'}返回 HTTP ${r.status}`;
        if (r.status === 401 || r.status === 403) msg = 'API Key 无效或没开通该模型，请到百炼控制台检查';
        else if (r.status === 429) msg = '额度用尽或触发限流，稍后再试';
        else {
          try { msg += `：${(JSON.parse(text).error || {}).message || text.slice(0, 120)}`; } catch { msg += `：${text.slice(0, 120)}`; }
        }
        errors.push(msg);
        for (const im of group) results.push({ name: im.name, error: msg });
        continue;
      }
      let j;
      try { j = JSON.parse(text); } catch { throw new Error('返回的不是 JSON'); }
      const c = j?.choices?.[0]?.message?.content;
      const parsed = parseReply(c, group.length);
      if (parsed.error) { errors.push(parsed.error); for (const im of group) results.push({ name: im.name, error: parsed.error }); continue; }
      const list = parsed.list || [];
      for (let k = 0; k < group.length; k += 1) {
        results.push({ name: group[k].name, ai: list[k] || null, ...(list[k] ? {} : { error: '这张没拿到结果' }) });
      }
    } catch (err) {
      const hint = engine === 'local'
        ? `连不上本地模型服务（${ep.url}）。请先启动 llama-server，或检查地址。${err.message}`
        : `云端请求失败：${err.message}`;
      errors.push(hint);
      for (const im of group) results.push({ name: im.name, error: hint });
    }
  }
  return { ok: errors.length === 0, engine, model: ep.model, taxon, strict, results, errors: errors.slice(0, 3) };
}

/** 连通性自检：不传图，问一句最短的话，只判断地址和 Key 通不通 */
async function test(o) {
  const engine = o.engine === 'local' ? 'local' : 'cloud';
  const cfg = o.cfg || {};
  const ep = endpoint(cfg, engine);
  if (ep.error) return { ok: false, error: ep.error };
  if (!ep.model) return { ok: false, error: '请先填模型名' };
  if (engine === 'cloud' && !o.key) return { ok: false, error: '请先填云端 API Key' };
  const headers = { 'content-type': 'application/json' };
  if (engine === 'cloud') headers.authorization = `Bearer ${o.key}`;
  try {
    const r = await fetch(ep.url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: ep.model, messages: [{ role: 'user', content: '回复 OK 两个字母' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(20000),
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}：${t.slice(0, 160)}` };
    return { ok: true, engine, model: ep.model };
  } catch (err) {
    return { ok: false, error: engine === 'local'
      ? `连不上 ${ep.url}：${err.message}` : `连不上百炼：${err.message}` };
  }
}

module.exports = {
  run, test, CLOUD_MODELS, LOCAL_GUIDE, TAXA: Object.keys(TAXA),
  buildPrompt, buildPromptBatch, parseReply, isInsectTaxon,
};
