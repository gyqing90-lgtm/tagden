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

/**
 * 每个评分对象一套独立判据。
 *
 * 为什么不是一套模板套所有类群：小参数视觉模型（4B 级）对关键词特别敏感。
 * 旧版把所有类群塞进同一个模板，反例写成「例如只有昆虫或只有植物」——
 * 选了植物，模型读到的还是「昆虫」，于是回一句「画面里没有昆虫」→ AI 0 分。
 * 现在每个类群只写自己的判据、只拿自己的反例举例，绝不跨类群串味：
 * 植物那套里连「昆虫」两个字都不出现（test/score-prompt.test.js 盯着这一点）。
 */
const SUBJECTS = {
  '昆虫': {
    noun: '昆虫',
    label: '昆虫（含蜘蛛等其他节肢动物）',
    kinds: '甲虫 / 蝴蝶 / 蜜蜂 / 蜘蛛 / 无',
    presence: '画面中是否真的出现了昆虫主体？若画面里只有花草树木、鸟兽、真菌、人物或纯风景，必须判为「无」。',
    criteria: '昆虫主体是否可清晰辨认到可用于物种鉴定（主体大小占比、对焦清晰度、姿态角度）',
    parts: '触角、复眼、足（胫节与跗节）、翅（翅脉与翅斑）、鞘翅与前胸背板、腹部斑纹、体表刻点与毛被',
    notes: '白底标本照属于正常拍摄，背景过曝不扣分；标本针、标签、比例尺不扣分；远处飞行的小点判为模糊',
    strictNote: '若画面里是蜘蛛、蜈蚣、马陆、蝎等非昆虫节肢动物，has_subject 仍判为「有」，但 subject_kind 必须如实写「蜘蛛 / 蜈蚣 / 马陆 / 蝎」，不要冒充昆虫。',
  },
  '鸟类': {
    noun: '鸟类',
    label: '鸟类',
    kinds: '林鸟 / 水鸟 / 猛禽 / 无',
    presence: '画面中是否真的出现了鸟？若画面里只有花草树木、昆虫、兽类、人物或纯风景，必须判为「无」。',
    criteria: '鸟体是否可辨认到种级（羽色与斑纹、体型与喙形、姿态角度，有无枝叶遮挡）',
    parts: '喙形与嘴裂、眼先与眉纹、羽色与翼斑、尾羽形态、跗跖与趾',
    notes: '逆光剪影、树枝遮挡、远距离飞版都属于常见拍摄条件，只要关键特征可辨就不扣分；只剩一个小黑点判为模糊',
    strictNote: '若画面里是笼养鸟、家禽或标本，仍按鸟类评，但 subject_kind 要如实写「笼养鸟 / 家禽 / 标本」。',
  },
  '植物': {
    noun: '植物',
    label: '植物（花、果实、叶片或整株）',
    kinds: '乔木 / 灌木 / 草本 / 花 / 叶 / 果实 / 无',
    presence: '画面中是否真的出现了植物主体（花、果、叶、整株或树干）？若画面里只有动物、真菌、人物或纯风景（山、水、建筑），必须判为「无」。',
    criteria: '物种识别关键特征（花冠与花序结构、叶形与叶脉、果实形态、树皮纹理、整体株型与分枝方式）是否清晰可辨',
    parts: '花（花冠 / 花序 / 花萼）、叶（叶形 / 叶缘 / 叶脉 / 叶序）、果实与种子、树皮与枝条、整株株型',
    notes: '腊叶标本、白底或纯色背景的证件照式拍摄属于正常记录方式，不扣分；只拍到远处一片绿、看不出叶形与花结构的判为模糊；画面里顺带出现的其他生物或人物不算主体',
    strictNote: '苔藓、蕨类、藻类、栽培花卉、盆景和切花都属于植物，不要判为无；若为栽培或标本，subject_kind 如实写「栽培花卉 / 盆景 / 切花 / 腊叶标本」。',
  },
  '兽类': {
    noun: '兽类',
    label: '兽类（哺乳动物）',
    kinds: '食肉兽 / 鹿类 / 啮齿类 / 蝙蝠 / 无',
    presence: '画面中是否真的出现了兽类（哺乳动物）？若画面里只有花草树木、鸟、昆虫、人物或纯风景，必须判为「无」。',
    criteria: '体躯形态、毛色斑纹、头面部特征是否可辨，有无遮挡',
    parts: '头面部（耳 / 吻 / 眼）、毛色与斑纹、体型与四肢、角或獠牙等附属结构、尾形',
    notes: '红外相机夜拍（灰白或偏色）属于正常记录方式，不扣分；只剩模糊热影或远距离小点判为模糊',
    strictNote: '若画面里是家畜、宠物或圈养个体，仍按兽类评，但 subject_kind 要如实写「家畜 / 宠物 / 圈养」。',
  },
  '两栖爬行动物': {
    noun: '两栖或爬行动物',
    label: '两栖或爬行动物',
    kinds: '蛙类 / 蝾螈 / 蜥蜴 / 蛇 / 龟鳖 / 无',
    presence: '画面中是否真的出现了两栖或爬行动物（蛙、蟾、蝾螈、蜥蜴、蛇、龟鳖等）？若画面里只有花草树木、鸟兽、昆虫、人物或纯风景，必须判为「无」。',
    criteria: '皮肤纹理、斑纹、鳞片、体型与头部特征是否清晰可辨',
    parts: '头部（吻 / 眼 / 鼓膜）、皮肤或鳞片纹理、体侧斑纹、四肢与趾（吸盘 / 爪）、尾部形态',
    notes: '夜间手电补光、湿滑反光属于常见拍摄条件，不扣分；只拍到一段身体、头部不在画面内判为可辨以下',
    strictNote: '若画面里是幼体、蝌蚪或卵块，仍按该类群评，subject_kind 如实写「幼体 / 蝌蚪 / 卵块」。',
  },
  '通用(自动判断)': {
    noun: '生物主体',
    label: '明确的生物主体（动物、植物或真菌等）',
    kinds: '动物 / 植物 / 真菌 / 无',
    presence: '画面中是否真的出现了可辨认的生物主体（动物、植物或真菌）？若画面里只有人、建筑、器物或纯风景，必须判为「无」。',
    criteria: '主体是否清晰可辨、特征是否足以判断其类群',
    parts: '能体现类群归属的关键特征',
    notes: '白底标本照属于正常拍摄，背景过曝不扣分；远距离小点判为模糊',
    strict: false, // 没指定类群就没有「专用判据」可言
  },
};

const TAXA = Object.keys(SUBJECTS);

/** 别名 → 类群 key。容忍带括号的长标签、全角空格、旧配置里的脏值 */
const TAXON_ALIASES = [
  ['昆虫', /昆虫|节肢|蜘蛛|甲虫|蝴蝶|蛾/],
  ['鸟类', /鸟/],
  ['植物', /植物|花草|树木|植/],
  ['兽类', /兽|哺乳/],
  ['两栖爬行动物', /两栖|爬行|蛙|蛇|蜥蜴|龟/],
  ['通用(自动判断)', /通用|自动|不限|其他/],
];

/** 把任意写法收敛到一个合法类群 key；认不出来返回空串（别再静默退回昆虫） */
function resolveTaxon(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  if (SUBJECTS[s]) return s;
  for (const [key, re] of TAXON_ALIASES) if (re.test(s)) return key;
  return '';
}

function isInsectTaxon(t) { return resolveTaxon(t) === '昆虫'; }

/** 该类群是否支持「专用检测」（严格判据） */
function canStrict(t) {
  const k = resolveTaxon(t);
  return !!k && SUBJECTS[k].strict !== false;
}

function buildPrompt(taxon, strict) {
  const key = resolveTaxon(taxon) || '昆虫';
  const s = SUBJECTS[key];
  const head = [
    `评分对象: ${s.label}。`,
    `本次只评审${s.noun}：只按${s.noun}的鉴定判据打分，不要套用其他类群的标准，也不要因为画面里出现别的生物而扣分。`,
  ];
  const body = [];
  if (strict && s.strict !== false) {
    body.push(`【专用${s.noun}检测模式】按${s.noun}鉴定标准严格判断:`);
    body.push(`1) ${s.presence}`);
    if (s.strictNote) body.push(s.strictNote);
    body.push(`2) 鉴定关键部位是否清晰: ${s.parts}。至少两处关键部位清晰可辨才算 clarity=清晰; 全形清楚但细节糊判为可辨。`);
    body.push('3) 构图与背景: 主体占画面比例、遮挡程度、背景杂物干扰。');
    body.push(`注意: ${s.notes}。`);
    body.push(`评分标准: 画面没有${s.noun}=0~15分; 有但关键部位模糊或严重遮挡=20~35; `
      + '关键部位清晰、可用于鉴定=60~80; 全形与细节都清晰精美=85~100。');
  } else {
    body.push('请严格判断以下三点:');
    body.push(`1) ${s.presence}`);
    body.push(`2) ${s.criteria}。`);
    body.push('3) 构图与背景: 主体占画面比例、遮挡程度、背景是否干扰特征判读。');
    body.push(`注意: ${s.notes}。`);
    body.push(`评分标准: 画面没有${s.noun}=0~15分; 有但难以辨认=20~35; `
      + `可辨认、可用于鉴定=60~80; 清晰精美=85~100。`);
  }
  body.push('只输出一个JSON对象, 不要任何其他文字:');
  body.push(`{"has_subject":"有|疑似|无","subject_kind":"画面主体(如 ${s.kinds})",`
    + '"clarity":"清晰|可辨|模糊","composition":"好|一般|差",'
    + '"key_parts":"清晰可辨的鉴定部位, 看不清则写 无",'
    + '"score":0到100的整数,"comment":"20字以内中文点评"}');
  return head.concat(body).join('\n');
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
  const has = String(j.has_subject || j.has_insect || '');
  return {
    // has_subject 是现在的字段名；has_insect 留着兼容旧记录与旧前端
    has_subject: has,
    has_insect: has,
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
  const taxon = resolveTaxon(o.taxon) || resolveTaxon(set.taxon) || '昆虫';
  // 专用检测现在按类群各有一套判据（昆虫/鸟类/植物/兽类/两栖爬行），
  // 「通用」没有专属判据，勾了也忽略。旧版只认昆虫，选了植物连严格判据都用不上。
  const wantStrict = o.strict === undefined || o.strict === null ? !!set.strict : !!o.strict;
  const strict = wantStrict && canStrict(taxon);
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
  run, test, CLOUD_MODELS, LOCAL_GUIDE, TAXA,
  SUBJECTS, resolveTaxon, canStrict,
  buildPrompt, buildPromptBatch, parseReply, isInsectTaxon,
};
