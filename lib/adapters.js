'use strict';

const { Jar, request, requestJson, SiteError } = require('./http');
const ebird = require('./ebird');
const inat = require('./inat');
const ppbc = require('./ppbc');
const baidu = require('./baidu');
const { parseQuarryman, parseDuoshi, extractCandidates } = require('./parse');
const NATSHARE = require('./nat-share');

/* 采石工（晓虫）的各个识别分区：同一套上传/解析逻辑，只是路径不同。
   vendor 表示「同属于一个网站」——前端按它做模型互斥：同一个网站只能开一个模型。 */
const QUARRYMAN_GROUPS = [
  { key: 'quarryman-plant', path: 'plant', group: 'plant', short: '晓虫·植物', name: '晓虫 植物识别', note: '中国植物识别，无需登录' },
  { key: 'quarryman-fungi', path: 'fungi', group: 'fungi', short: '晓虫·菌物', name: '晓虫 菌物识别', note: '真菌识别，无需登录' },
  { key: 'quarryman-snake', path: 'snake', group: 'herp', short: '晓虫·蛇类', name: '晓虫 蛇类识别', note: '中国蛇类识别，无需登录' },
  { key: 'quarryman-mollusk', path: 'mollusk', group: 'mollusk', short: '晓虫·贝类', name: '晓虫 贝类识别', note: '软体动物识别，无需登录' },
  { key: 'quarryman-rose', path: 'rose', group: 'plant', short: '晓虫·月季', name: '晓虫 月季识别', note: '月季品种识别，无需登录' },
];

/* 多识（duoshi.bio）的识别分组：接口只认 general / plant / bird 三种 predict_group，
   用的是同一个账号、同一个登录态，所以共用一个 cookie 容器 jar:'duoshi' */
const DUOSHI_GROUPS = [
  { key: 'duoshi', group: 'animal', predict: 'general', short: '多识·动物', name: '多识 动物（含昆虫）', note: '动物与昆虫识别；站方只有 动物/植物/鸟类 三组，昆虫在「动物」组里' },
  { key: 'duoshi-bird', group: 'bird', predict: 'bird', short: '多识·鸟类', name: '多识 鸟类识别', note: '鸟纲候选池（predict_group=bird），需登录' },
  { key: 'duoshi-plant', group: 'plant', predict: 'plant', short: '多识·植物', name: '多识 植物识别', note: '植物候选池（predict_group=plant），需登录' },
];

/* 懂鸟（HHOLOVE AI 开放平台）的动物类别：class 参数可用 B/M/A/R 组合。
 * 三类共用同一个 api_key 与同一份图像配额，所以做成三个独立站点、共用 account，
 * 用户按自己要认的类群勾；同时勾多个就是多花几次额度（每次识别 1 张图 = 1 次）。
 * 注意「其他1 F（鱼）/其他2 S」官方标注 v3.0 敬请期待，还没有识别能力，这里先不放。 */
const DONGNIAO_CLASSES = [
  { key: 'dongniao', cls: 'B', group: 'bird', short: '懂鸟·鸟', name: '懂鸟（鸟类）', note: '鸟类 11151 种，中文名、英文名、学名一起给' },
  { key: 'dongniao-mammal', cls: 'M', group: 'mammal', short: '懂鸟·兽', name: '懂鸟（兽类）', note: '兽类 3820 种（2026 版接口），同样给中英文学名' },
  { key: 'dongniao-herp', cls: 'AR', group: 'herp', short: '懂鸟·两爬', name: '懂鸟（两栖爬行）', note: '两栖 5589 种 + 爬行 8592 种，一次同时认两栖与爬行' },
];

/* 自然在线（ecp.ibiodiversity.cn，原来的「形色」）没有「直接传图识别」的接口，只能对「相册里已有的照片」调
   identify/xingse。所以流程是：拿令牌 → 传一张图进专用相册 → 鉴定 → 立刻删掉这张图。
   账号分两套，别混：
     · 识别用包里内置的那一枚（lib/nat-share.js，开箱即用，自己的中转相册识别完就清空）；
     · 相册、名录查询、写回鉴定用用户自己的账号（config.sites.xingse，账号密码 + 图片验证码，
       验证码只能人工看，所以登录走设置面板里的手输流程）。
   内置账号的令牌过期时，识别自动退回用户自己的令牌，别让植物识别整条断掉。 */
const XINGSE_BASE = 'https://ecp.ibiodiversity.cn';
const XINGSE_ALBUM_TITLE = '自然在线识别缓存（自动清理）';
const XINGSE_ADDR = {
  countryId: '2013010535',
  country: '中华人民共和国',
  regionID: '2013358038',
  region: '华东',
  provinceId: '2013036373',
  province: '福建省',
  cityId: '2013036374',
  city: '福州市',
  countyID: '2013036375',
  county: '福州市鼓楼区',
};

/* 豆包（字节跳动）：走官方「火山方舟」的视觉理解接口，OpenAI 兼容格式。
   它不像其它站点返回概率，而是「看图说话」，所以先用提示词逼它输出 JSON，
   再把它自报的 confidence 当成 0~100 的分数用。密钥在设置面板里填。 */
// BIOID_ARK_BASE 只用于自测（指向本地假服务器）或走代理，正常不用设
const DOUBAO_BASE = (process.env.BIOID_ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
const KUAITONG_BASE = (process.env.BIOID_KT_BASE || 'https://ai.inspirvision.cn').replace(/\/+$/, '');
/* 懂鸟：走官方授权通道 —— HHOLOVE AI 开放平台（懂鸟与 HHO 联合推出的识别 API）。
   注意不用网页版 dongniao.net 背后的 /niaodian2：那条路有反机器人核验，绕过去等于
   跟对方风控对着干。官方 API 是 api_key 放 header，识别**异步**：
     上传 → 拿到 resultid → 每 1~2 秒轮询「获取识别结果」→ 数组里是每只动物的候选列表
   另外 quota=1 能查剩余次数、且不消耗配额，正好当连通性检测。
   免费测试额度用完后按次计费，所以这个站点默认不勾选。 */
const DONGNIAO_BASE = (process.env.BIOID_DN_BASE || 'https://ai.open.hhodata.com/api/v2').replace(/\/+$/, '');
const DOUBAO_MODEL = 'doubao-seed-2-1-pro-260915';
const DOUBAO_PROMPT = `你是物种鉴定助手。请观察这张照片，判断画面中最主要的那一种生物（动物、植物或真菌）。

只输出一个 JSON 对象，不要写解释，不要加 markdown 代码块。格式如下：
{"taxon":"animal|plant|fungus|other","candidates":[{"cn":"中文名","latin":"学名","confidence":0.0,"why":"不超过20字的依据"}]}

规则：
1. candidates 最多 5 个，按你的把握从高到低排列。
2. confidence 是 0 到 1 的小数，表示你认为它是这个物种的把握；多个候选不必加起来等于 1。
3. latin 填拉丁学名，属名首字母大写。只认得属就填属名，只认得科就填科名。
4. 画面里看不出生物、或图片与生物无关时，candidates 给空数组。`;

const SITE_META = {
  ...Object.fromEntries(
    DUOSHI_GROUPS.map((g) => [
      g.key,
      {
        key: g.key,
        name: g.name,
        short: g.short,
        home: 'https://duoshi.bio/#/',
        auth: 'login',
        jar: 'duoshi',      // 三个分组共用同一份 cookie / 登录态
        account: 'duoshi',  // 账号密码都存在 config.sites.duoshi 里
        vendor: 'duoshi',   // 同一个网站 → 三选一，前端互斥
        group: g.group,     // 类群标签，前端按它分组排列
        predictGroup: g.predict,
        note: g.note,
      },
    ]),
  ),
  inaturalist: {
    key: 'inaturalist',
    name: 'iNaturalist',
    short: 'iNaturalist',
    home: 'https://www.inaturalist.org/',
    auth: 'login',
    group: 'general',
    note: '全球公民科学平台，视觉匹配 + 地理先验',
    // 只影响结果里学名旁那两个按钮（「iNat」「PPBC」）跳到哪个地区（识别本身不受影响）。
    // 选项由 lib/inat.js 给，placeId 已经在里面查好了；kind / continent 用来分 optgroup。
    // ppbc 是同一地区的植物智省名（「福建省」这种全称，见 lib/ppbc.js），
    // 中国境外的地区那里是空串 —— 植物智只收国内照片，空串等于按全国范围打开。
    // 这个字段已经挪到主页面（「检索地区」那一行），不在账号设置里显示。
    fields: [
      {
        key: 'place',
        label: '检索地区（「iNat」「PPBC」按钮用）',
        type: 'place',
        hideInSettings: true,
        options: inat.PLACES.map((p) => ({ ...p, ppbc: ppbc.provinceOf(p.code) })),
        continents: inat.CONTINENTS,
      },
    ],
  },
  quarryman: {
    key: 'quarryman',
    name: '晓虫 昆虫识别',
    short: '晓虫·昆虫',
    home: 'https://www.quarryman.cn/insect',
    auth: 'none',
    vendor: 'quarryman',
    group: 'insect',
    path: 'insect',
    note: '19178 个昆虫及陆生节肢动物单元，无需登录',
  },
  ...Object.fromEntries(
    QUARRYMAN_GROUPS.map((g) => [
      g.key,
      { key: g.key, name: g.name, short: g.short, home: `https://www.quarryman.cn/${g.path}`, auth: 'none', vendor: 'quarryman', group: g.group, path: g.path, note: g.note },
    ]),
  ),
  iplant: {
    key: 'iplant',
    name: '植物智 iPlant（2 万物种）',
    short: '植物智·20k',
    home: 'https://www.iplant.cn/stu/20k',
    auth: 'none',
    group: 'plant',
    note: '中科院植物所 20150 种模型，仅接受 JPG',
  },
  plantnet: {
    key: 'plantnet',
    name: 'Pl@ntNet（植物）',
    short: 'Pl@ntNet',
    home: 'https://plantnet.org/',
    auth: 'key',
    account: 'plantnet',
    group: 'plant',
    note: '法国 Pl@ntNet 官方接口：世界植物 7.3 万种，中国区系 3.4 万种；可指定区系，免费每天 500 次',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: '粘贴 my.plantnet.org 里那串 API Key' },
      {
        key: 'project',
        label: '区系（认哪一片的植物）',
        type: 'select',
        placeholder: 'all',
        options: [
          { value: 'all', label: '自动（all，按图判断最合适的区系）' },
          { value: 'k-china', label: '中国（k-china，3.4 万种）' },
          { value: 'k-eastern-asia', label: '东亚（k-eastern-asia）' },
          { value: 'k-indo-china', label: '中南半岛（k-indo-china）' },
          { value: 'k-world-flora', label: '世界（k-world-flora，7.3 万种）' },
          { value: 'useful', label: '栽培与有用植物（useful）' },
          { value: 'weeds', label: '农田杂草（weeds）' },
          { value: 'invasion', label: '入侵植物（invasion）' },
        ],
        hint: '选「中国」时只认本土野生种，拍的若是园艺栽培种可能认不出，那就换回「自动」或「世界」。',
      },
    ],
    hint: '在 my.plantnet.org 注册后就能拿到免费 Key（每天 500 次，够几百张图）。它只认维管植物 —— 虫、鸟、真菌都不是它的范围，那些用别的站。',
  },

  xingse: {
    key: 'xingse',
    name: '自然在线（植物识别）',
    short: '自然在线',
    home: 'https://ecp.ibiodiversity.cn/myNature',
    auth: 'captcha',    // 账号密码 + 图片验证码，验证码只能人工输入
    manualAuth: true,   // 「保存并登录」不代登，登录走 /api/xingse/login
    account: 'xingse',
    group: 'plant',
    note: '植物识别；识别走程序内置的账号，开箱即用（相册/写回鉴定才需要登录自己的账号）',
  },
  butterflyai: {
    key: 'butterflyai',
    name: '文浩识蛾',
    short: '文浩识蛾',
    home: 'https://www.butterflyai.cc/static/mothweb/webfiles/about/ai.html',
    auth: 'none',
    vendor: 'butterflyai',
    group: 'insect',
    engine: 'wenhao',
    note: '中国境内蛾种，无需登录',
  },
  /* 识蝶页与识蛾页共用同一个 /uploadbut/ 接口与模型，同引擎只请求一次、结果去重 */
  'butterflyai-butterfly': {
    key: 'butterflyai-butterfly',
    name: '文浩识蝶',
    short: '文浩识蝶',
    home: 'https://www.butterflyai.cc/static/butweb/webfiles/about/ai.html',
    auth: 'none',
    vendor: 'butterflyai',
    group: 'insect',
    engine: 'wenhao',
    note: '中国境内蝶种；与识蛾共用同一引擎，结果去重后不重复计票',
  },
  doubao: {
    key: 'doubao',
    name: '豆包（视觉理解）',
    short: '豆包',
    home: 'https://www.doubao.com/chat/',
    auth: 'key',        // 用「火山方舟」的 API Key，不涉及账号密码
    account: 'doubao',
    group: 'general',
    note: '字节豆包视觉模型，靠看图推理给候选，需要填火山方舟 API Key',
    fields: [
      { key: 'apiKey', label: '方舟 API Key', secret: true, placeholder: '粘贴 API Key' },
      { key: 'model', label: '模型 ID', placeholder: 'doubao-seed-2-1-pro-260915' },
    ],
    hint: '按量计费，识别一张约 1 分钱。模型 ID 留空即用默认。',
  },
  kuaitong: {
    key: 'kuaitong',
    name: '快瞳 AI（鸟类）',
    short: '快瞳·鸟',
    home: 'https://www.inspirvision.cn',
    auth: 'key',
    account: 'kuaitong',
    group: 'bird',
    note: '国内 1400+ 鸟种，支持静止与飞行、可同时识别多只鸟并给出位置',
    fields: [
      { key: 'accessKey', label: 'accessKey', secret: true, placeholder: 'APPID_…' },
      { key: 'accessSecret', label: 'accessSecret', secret: true, placeholder: '粘贴 accessSecret' },
    ],
    hint: '只认鸟类，非鸟图片会提示「没认出鸟」。令牌可自动续期，失效后会用这两个密钥重新换。',
  },
  /* 懂鸟按动物类别拆成三个站点（鸟 / 兽 / 两爬），共用同一把 api_key：
     设置面板只在「懂鸟·鸟」下显示输入框，另外两个标「共用账号」。
     class 字段会一路传到 identifyDongniao(img, cls)。 */
  ...Object.fromEntries(
    DONGNIAO_CLASSES.map((g) => [
      g.key,
      {
        key: g.key,
        name: g.name,
        short: g.short,
        home: 'https://ai.open.hhodata.com/',
        auth: 'key',
        account: 'dongniao',
        vendor: 'dongniao',
        group: g.group,
        dongniaoClass: g.cls,
        note: g.note,
        fields: [{ key: 'apiKey', label: 'apiKey', secret: true, placeholder: '粘贴 HHO 平台的 api_key' }],
        hint:
          g.key === 'dongniao'
            ? '在 ai.open.hhodata.com 注册后复制 api_key。鸟/兽/两爬三个站点共用这一把 key 和同一份图像额度；同一时间只能开一个（认哪类就开哪个），一次识别花一次。点「保存并登录」会显示剩余次数。'
            : '',
      },
    ]),
  ),
  /* 百度智能云：动物识别 / 植物识别，AK+SK 换 token。
     注意它只回中文名，合并表里靠中文名归并（见 lib/aggregate.js）。 */
  'baidu-animal': {
    key: 'baidu-animal',
    name: '百度 动物识别',
    short: '百度·动物',
    home: 'https://ai.baidu.com/tech/imagerecognition/animal',
    auth: 'key',
    account: 'baidu-animal',
    vendor: 'baidu',
    group: 'animal',
    note: '百度智能云动物识别：上万物种，鸟兽虫鱼都认；只给中文名，无学名',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: '粘贴应用的 API Key' },
      { key: 'secretKey', label: 'Secret Key', secret: true, placeholder: '粘贴应用的 Secret Key' },
    ],
    hint: '在 console.bce.baidu.com 建「图像识别」应用后拿这组 AK/SK。动物识别和植物识别是两个独立接口、各自计费，一条鱼或一只虫子也归在动物里。',
  },
  'baidu-plant': {
    key: 'baidu-plant',
    name: '百度 植物识别',
    short: '百度·植物',
    home: 'https://ai.baidu.com/tech/imagerecognition/plant',
    auth: 'key',
    account: 'baidu-plant',
    vendor: 'baidu',
    group: 'plant',
    note: '百度智能云植物识别：2 万+ 种植物，识别快；只给中文名，Top1 常带学名',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: '粘贴应用的 API Key' },
      { key: 'secretKey', label: 'Secret Key', secret: true, placeholder: '粘贴应用的 Secret Key' },
    ],
    hint: '与动物识别是两套独立的应用/计费，可以分别填。只认植物，虫子照片会返回「非植物」。',
  },
  /* eBird 不做图片识别（Merlin 不对外开放），它的位置是「地区记录核对」：
     识别完成后再拿候选学名去查本地区近 14 天有没有人记录过。
     所以 meta 里带 verify:true —— 它不参与多站投票，也不算进 Top5 的合并分。 */
  ebird: {
    key: 'ebird',
    name: 'eBird 地区记录',
    short: 'eBird',
    home: 'https://ebird.org/',
    auth: 'key',
    account: 'ebird',
    group: 'bird',
    verify: true,
    note: '康奈尔鸟类学实验室：核对候选鸟种在本地区近 14 天有没有记录，用来判断「这季节这地方出现它合不合理」',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, placeholder: '粘贴 eBird API key' },
      {
        key: 'region',
        label: '所在地区',
        type: 'region',
        // 不在「账号设置」里显示：点站点条上的 eBird 会弹窗选（可用浏览器定位自动填）
        hideInSettings: true,
        placeholder: '留空默认上海（CN-31），也可手填代码',
        options: ebird.REGIONS,
      },
    ],
    hint: '地区不在账号设置里改：点站点条上的「eBird」就会弹出来，能按浏览器定位自动填，也可以手动选。查一次缓存一天，同一物种当天不会重复请求；换地区后立刻生效。',
  },
};

class Sites {
  constructor(config) {
    this.config = config;
    this.jars = {};
    this.state = {};
    this.inatToken = null;
    this.inatTokenAt = 0;
    this.duoshiLoginPromise = null;
    this.ktPath = null; // 快瞳用国内还是全球鸟类接口，探一次记住
    this.persistConfig = null; // 由 server.js 注入：令牌/相册 ID 变更后立刻落盘
    for (const [key, meta] of Object.entries(SITE_META)) {
      const jarKey = meta.jar || key;
      // 同 jar 的多个分组（多识三分组）只建一个容器、共用登录态
      if (!this.jars[jarKey]) this.jars[jarKey] = new Jar(config.sessions?.[jarKey] || []);
      this.state[key] =
        meta.auth === 'none'
          ? { ok: true, message: '无需登录', at: Date.now() }
          : meta.auth === 'captcha'
            ? {
                ok: false,
                message: config.sites?.[key]?.token ? '已保存令牌' : '待输入验证码',
                at: 0,
              }
            : meta.auth === 'key'
              ? (() => {
                  // 共用账号的站点（懂鸟三分类）去看 account 那份配置
                  const c = config.sites?.[meta.account || key] || {};
                  const has = (meta.fields || [{ key: 'apiKey', secret: true }]).some((f) => f.secret && c[f.key]);
                  return { ok: false, message: has ? '已保存密钥' : '待填密钥', at: 0 };
                })()
            : meta.auth === 'manual'
              ? (() => {
                  const c = config.sites?.[key] || {};
                  const has = (meta.fields || []).some((f) => c[f.key]);
                  return { ok: false, message: has ? '已保存核验凭据' : '待核验', at: 0 };
                })()
              : { ok: false, message: '未连接', at: 0 };
    }
  }

  /* 该站点实际使用的 cookie 容器（多识三分组共用 duoshi） */
  jarOf(key) {
    const meta = SITE_META[key] || {};
    return this.jars[meta.jar || key];
  }

  meta() {
    return Object.values(SITE_META).map((m) => ({ ...m, state: this.state[m.key] }));
  }

  sessions() {
    const out = {};
    for (const [k, jar] of Object.entries(this.jars)) out[k] = jar.toJSON();
    return out;
  }

  setState(key, ok, message) {
    this.state[key] = { ok, message, at: Date.now() };
  }

  /** 多识三分组共用登录态，状态一起刷新 */
  setDuoshiState(ok, message) {
    for (const g of DUOSHI_GROUPS) this.setState(g.key, ok, message);
  }

  async login(key, force = false) {
    if (key === 'inaturalist') return this.loginINat();
    if (key === 'xingse') return this.checkXingse();
    if (key === 'plantnet') return this.checkPlantnet();
    if (key === 'doubao') return this.checkDoubao();
    if (key === 'kuaitong') return this.checkKuaitong();
    if (key === 'baidu-animal' || key === 'baidu-plant') return this.checkBaidu(key);
    if (SITE_META[key]?.account === 'dongniao') return this.checkDongniao();
    if (key === 'ebird') return this.checkEbird();
    if (SITE_META[key]?.account === 'duoshi') return this.loginDuoshi(key, force);
    this.setState(key, true, '无需登录');
    return true;
  }

  /* ---------------- iNaturalist ---------------- */

  async loginINat() {
    const cfg = this.config.sites.inaturalist || {};
    const jar = this.jars.inaturalist;
    jar.clear();
    try {
      if (!cfg.username || !cfg.password) {
        throw new SiteError('未配置 iNaturalist 账号密码');
      }
      const page = await request('https://www.inaturalist.org/login', { jar });
      const html = await page.text();
      const token = (html.match(/name="authenticity_token" value="([^"]+)"/) || [])[1];
      if (!token) throw new SiteError('登录页结构异常，未取到 CSRF token');

      const body = new URLSearchParams({
        authenticity_token: token,
        'user[email]': cfg.username,
        'user[password]': cfg.password,
        'user[remember_me]': '1',
      });
      const res = await request('https://www.inaturalist.org/session', {
        jar,
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://www.inaturalist.org',
          referer: 'https://www.inaturalist.org/login',
        },
        body: body.toString(),
      });
      const loc = res.headers.get('location') || '';
      if (res.status !== 302 || /\/login/.test(loc)) {
        throw new SiteError('账号或密码不正确', { status: res.status });
      }
      await this.fetchINatToken(jar, true);
      this.setState('inaturalist', true, `已登录 ${cfg.username}`);
      return true;
    } catch (err) {
      this.setState('inaturalist', false, err.message || '登录失败');
      throw err;
    }
  }

  async fetchINatToken(jar, force = false) {
    if (!force && this.inatToken && Date.now() - this.inatTokenAt < 20 * 3600 * 1000) {
      return this.inatToken;
    }
    const { res, json } = await requestJson('https://www.inaturalist.org/users/api_token', {
      jar,
      headers: { accept: 'application/json', referer: 'https://www.inaturalist.org/home' },
    });
    if (!res.ok || !json?.api_token) {
      throw new SiteError('获取 API Token 失败（会话可能已过期）', { status: res.status });
    }
    this.inatToken = json.api_token;
    this.inatTokenAt = Date.now();
    return this.inatToken;
  }

  async identifyINat(img) {
    const jar = this.jars.inaturalist;
    let token = await this.fetchINatToken(jar);
    const call = async (tk) => {
      const fd = new FormData();
      fd.append('image', new Blob([img.buffer], { type: img.mime }), img.filename);
      const res = await request('https://api.inaturalist.org/v1/computervision/score_image', {
        method: 'POST',
        headers: { authorization: `Bearer ${tk}`, accept: 'application/json' },
        body: fd,
        timeout: 120000,
      });
      return res;
    };

    let res = await call(token);
    if (res.status === 401) {
      token = await this.fetchINatToken(this.jars.inaturalist, true);
      res = await call(token);
    }
    if (!res.ok) {
      const txt = await res.text();
      // iNat 的 CV 服务对「没法打分」的图统一回 500 Error scoring image：
      // 常见的不是网络问题，而是图太糊、主体太小、或者大片纯色/噪点。
      if (res.status === 500 && /Error scoring image/i.test(txt)) {
        throw new SiteError('iNaturalist 没能给这张图打分（主体太小、画面太糊，或大片纯色/噪点都会这样），换张清晰些的再试', {
          status: 500,
        });
      }
      throw new SiteError(`接口返回 ${res.status} ${txt.slice(0, 120)}`, { status: res.status });
    }
    const json = await res.json();
    const items = (json.results || []).map((r, i) => {
      const latin = r.taxon?.name || '';
      const common = r.taxon?.preferred_common_name || '';
      return {
        latin,
        cn: common && common.toLowerCase() !== latin.toLowerCase() ? common : '',
        score: Number(r.combined_score ?? r.vision_score ?? 0),
        rank: i + 1,
        rankLevel: r.taxon?.rank,
      };
    }).filter((it) => it.latin);
    return items;
  }

  /* ---------------- 多识 duoshi ---------------- */

  async loginDuoshi(key = 'duoshi', force = false) {
    const cfg = this.config.sites.duoshi || {};
    const jar = this.jars.duoshi;
    // 三个分组共用登录态：已有 cookie 就先探一下还有没有效，有效则不必重复登录
    if (!force && jar.size() > 0) {
      try {
        const me = await request('https://duoshi.bio/api/auth/me', {
          jar,
          headers: { accept: 'application/json' },
        });
        if (me.ok) {
          this.setDuoshiState(true, `已登录 ${cfg.username || ''}`.trim());
          return true;
        }
      } catch {
        /* 探活失败（网络问题）就当作没登录，走下面的完整登录 */
      }
    }
    jar.clear();
    try {
      if (!cfg.username || !cfg.password) throw new SiteError('未配置多识账号密码');
      const res = await request('https://duoshi.bio/api/auth/login', {
        jar,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://duoshi.bio',
          referer: 'https://duoshi.bio/',
        },
        body: JSON.stringify({ username: cfg.username, password: cfg.password }),
      });
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 150);
        throw new SiteError(
          res.status === 401 ? '账号或密码不正确（401）' : `登录失败 ${res.status} ${txt}`,
          { status: res.status },
        );
      }
      this.setDuoshiState(true, `已登录 ${cfg.username}`);
      return true;
    } catch (err) {
      this.setDuoshiState(false, err.message || '登录失败');
      throw err;
    }
  }

  async identifyDuoshi(img, predictGroup = 'general') {
    // 多识限制长边 ≤640，优先用前端压好的副本
    const useSmall = !!img.small;
    const buffer = useSmall ? img.small : img.buffer;
    const mime = useSmall ? 'image/jpeg' : img.mime;
    const filename = useSmall
      ? img.filename.replace(/\.[^.]+$/, '') + '.jpg'
      : img.filename;
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), filename);
    const url = `https://duoshi.bio/api/imgs/?predict_group=${encodeURIComponent(
      predictGroup || 'general',
    )}`;
    const res = await request(url, {
      jar: this.jars.duoshi,
      method: 'POST',
      headers: { origin: 'https://duoshi.bio', referer: 'https://duoshi.bio/' },
      body: fd,
      timeout: 150000,
    });
    if (res.status === 401) {
      this.setDuoshiState(false, '登录已过期，请重新登录');
      throw new SiteError('登录已过期，请重新登录', { status: 401 });
    }
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt.slice(0, 150);
      try {
        const j = JSON.parse(txt);
        if (j.detail) msg = String(j.detail);
      } catch {
        /* 非 JSON 错误体，原样带出 */
      }
      if (/exceeds max allowed/i.test(msg)) {
        msg = '图片超出多识 640×640 的限制（用网页界面上传会自动压缩，直连接口需自行缩小）';
      }
      throw new SiteError(`接口返回 ${res.status}：${msg}`, { status: res.status });
    }
    const json = await res.json();
    let items = parseDuoshi(json, 10);
    if (!items.length) items = extractCandidates(json, 10);
    if (!items.length) {
      throw new SiteError('未能从返回数据中解析出物种候选（接口结构可能已变）');
    }
    return items;
  }

  /* ---------------- 采石工 quarryman（含各分区） ---------------- */

  async identifyQuarryman(img, path = 'insect') {
    const fd = new FormData();
    fd.append('image', new Blob([img.buffer], { type: img.mime }), img.filename);
    const res = await request(`https://www.quarryman.cn/${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        referer: `https://www.quarryman.cn/${path}`,
        origin: 'https://www.quarryman.cn',
      },
      body: fd,
      timeout: 150000,
    });
    const loc = res.headers.get('location') || '';
    if (!loc) {
      throw new SiteError(`上传失败，接口返回 ${res.status}`);
    }
    if (/error=/.test(loc)) {
      const code = (loc.match(/error=(\d+)/) || [])[1];
      throw new SiteError(`站点拒绝识别（错误码 ${code}）`);
    }
    const page = await request(new URL(loc, 'https://www.quarryman.cn').toString(), {
      referer: `https://www.quarryman.cn/${path}`,
      timeout: 150000,
    });
    const html = await page.text();
    const items = parseQuarryman(html);
    if (!items.length) throw new SiteError('结果页未解析到物种（可能未检测到目标）');
    return items;
  }

  /* ---------------- 植物智 iPlant（stu 20k 物种模型） ---------------- */

  async identifyIPlant(img) {
    // 该接口只认 .jpg：前端已按需转好 JPEG 副本（非 JPEG 原图 / 过大的 JPEG）
    const buffer = img.jpeg || img.buffer;
    if (!buffer) {
      throw new SiteError('该站只接受 JPG 图片，未能生成 JPEG 副本');
    }
    if (!img.jpeg && !/jpe?g/i.test(img.mime || '')) {
      throw new SiteError('该站只接受 JPG 图片，当前图片无法转码');
    }
    const filename = img.filename.replace(/\.[^.]+$/, '') + '.jpg';
    const fd = new FormData();
    fd.append('0', new Blob([buffer], { type: 'image/jpeg' }), filename);
    fd.append('stutype', '20k');
    fd.append('type', 'files');

    const up = await request('https://www.iplant.cn/ashx/stuupload2.ashx', {
      method: 'POST',
      headers: {
        origin: 'https://www.iplant.cn',
        referer: 'https://www.iplant.cn/stu/20k',
      },
      body: fd,
      timeout: 120000,
    });
    if (!up.ok) throw new SiteError(`上传接口返回 ${up.status}`, { status: up.status });
    const upJson = await up.json().catch(() => null);
    if (!upJson) throw new SiteError('上传接口未返回 JSON（站点可能改版）');
    const stuid = String(upJson.id ?? '');
    if (String(upJson.s) !== '1' || !/^\d+$/.test(stuid)) {
      // 失败时 id 里放的是给用户看的提示，例如「只能上传jpg图片文件」
      throw new SiteError(stuid || '上传失败，未返回图片编号');
    }

    // 识别在服务端异步计算，刚上传时可能还没出分，轮询几次
    let detail = null;
    let last = '';
    for (let i = 0; i < 8; i++) {
      const { res, json } = await requestJson(
        `https://www.iplant.cn/ashx/getstulist.ashx?type=stuinfo&stuid=${stuid}`,
        {
          headers: { referer: 'https://www.iplant.cn/stu/20k' },
          timeout: 60000,
        },
      );
      if (!res.ok) throw new SiteError(`结果接口返回 ${res.status}`, { status: res.status });
      if (json?.error === 'success' && Array.isArray(json.stuscores) && json.stuscores.length) {
        detail = json;
        break;
      }
      last = json?.error || '';
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!detail) {
      throw new SiteError(last && last !== 'success' ? `未返回识别结果（${last}）` : '未返回识别结果（可能未识别到植物）');
    }

    const topLatin = String(detail.latin2 || '').trim();
    const items = detail.stuscores.slice(0, 10).map((it, i) => {
      const latin = String(it.name || '').trim();
      // 详情接口只给首选结果的中文名，顺带补上
      const cn = i === 0 && detail.cname && (!topLatin || topLatin === latin) ? String(detail.cname).trim() : '';
      return { latin, cn, score: Number(it.score) || 0, rank: i + 1 };
    }).filter((it) => it.latin);
    if (!items.length) throw new SiteError('未解析到物种候选');
    return items;
  }

  /* ---------------- Pl@ntNet 官方接口（my-api.plantnet.org） ---------------- */

  /** 只探密钥有效性：/v2/_status 不消耗识别次数 */
  async checkPlantnet() {
    const cfg = this.config.sites.plantnet || {};
    const apiKey = String(cfg.apiKey || '').trim();
    if (!apiKey) {
      this.setState('plantnet', false, '待填密钥');
      return false;
    }
    try {
      const { res, json } = await requestJson(
        `https://my-api.plantnet.org/v2/_status?api-key=${encodeURIComponent(apiKey)}`,
        { timeout: 30000 },
      );
      if (res.status === 401 || res.status === 403) {
        this.setState('plantnet', false, 'API Key 无效');
        return false;
      }
      if (!res.ok) {
        this.setState('plantnet', false, `校验失败 ${res.status}`);
        return false;
      }
      const ok = json?.status === 'ok' || res.ok;
      this.setState('plantnet', ok, ok ? '密钥可用' : '服务异常');
      return ok;
    } catch (err) {
      this.setState('plantnet', false, '校验失败：' + (err.message || err));
      return false;
    }
  }

  /**
   * POST /v2/identify/{project}?api-key=…&lang=…&nb-results=…
   *   multipart：images=（jpg/png，最多 5 张、合计 50MB）、organs=leaf|flower|fruit|bark|auto
   * 只认 JPG / PNG（HEIC 直接被拒），所以优先用前端转好的 JPEG 副本。
   *
   * 返回 results[].species：scientificNameWithoutAuthor / commonNames[]，score 是 0~1。
   * 它只有一块「植物」：项目全是维管植物区系（k-china / k-eastern-asia / useful …），
   * 没有真菌、昆虫之类的其他类群，所以只归在「植物」组里，不用拆成多个站点。
   *
   * 响应里的 remainingIdentificationRequests 是当天剩余次数（免费 500/天），
   * 顺手塞进站点状态里，用户能看到还剩多少，不用等到打不动才发现。
   */
  async identifyPlantnet(img) {
    const cfg = this.config.sites.plantnet || {};
    const apiKey = String(cfg.apiKey || '').trim();
    if (!apiKey) {
      throw new SiteError('还没填 Pl@ntNet 的 API Key：在 my.plantnet.org 注册后复制过来', { status: 401 });
    }

    // 额度守卫：免费版 500 次/天，用尽后 Pl@ntNet 只返回 429、不再识别。
    // 记下来后当天直接短路返回友好提示，不再白白发请求；到次日零点自动放行。
    const q = (this.plantnetQuota = this.plantnetQuota || { remaining: null, blockedUntil: 0 });
    if (q.remaining === 0 || Date.now() < q.blockedUntil) {
      const reset = q.blockedUntil ? new Date(q.blockedUntil) : (() => { const d = new Date(); d.setHours(24, 0, 0, 0); return d; })();
      const hh = String(reset.getHours()).padStart(2, '0');
      const mm = String(reset.getMinutes()).padStart(2, '0');
      throw new SiteError(`Pl@ntNet 今日免费额度已用完（500 次/天），约 ${hh}:${mm} 重置，先用别的站或明天再来`, { status: 429, quotaExhausted: true });
    }

    const buffer = img.jpeg || img.buffer;
    const mime = img.jpeg ? 'image/jpeg' : img.mime || '';
    if (!buffer || !/^image\/(jpe?g|png)$/i.test(mime)) {
      throw new SiteError('Pl@ntNet 只接受 JPG / PNG，这张图转不了码（HEIC 之类先另存为 JPG）');
    }
    const filename = img.filename.replace(/\.[^.]+$/, '') + (/png/i.test(mime) ? '.png' : '.jpg');

    // 区系名里带斜杠会把 URL 拆坏，掐掉两头的斜杠；空就用 all（让站方自己挑最合适的）
    const project = String(cfg.project || '').trim().replace(/^\/+|\/+$/g, '') || 'all';
    const url = (lang) => {
      const p = new URLSearchParams({ 'api-key': apiKey, 'nb-results': '10' });
      if (lang) p.set('lang', lang);
      return `https://my-api.plantnet.org/v2/identify/${encodeURIComponent(project)}?${p.toString()}`;
    };
    const post = async (lang) => {
      const fd = new FormData();
      fd.append('images', new Blob([buffer], { type: mime }), filename);
      const res = await request(url(lang), {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: fd,
        timeout: 150000,
      });
      const txt = await res.text();
      let json = null;
      try {
        json = JSON.parse(txt);
      } catch {
        /* 非 JSON（网关报错之类）留给下面统一处理 */
      }
      return { res, txt, json };
    };

    let { res, txt, json } = await post('zh');
    // 语言代码不被接受时（400 且提到 language），退回默认语言再试一次
    if (res.status === 400 && /language/i.test(txt)) ({ res, txt, json } = await post(''));

    if (res.status === 401 || res.status === 403) {
      throw new SiteError('Pl@ntNet 说 API Key 不对：去 my.plantnet.org 复制完整的一串（注意别带上空格）', { status: 401 });
    }
    if (res.status === 404) {
      // 站方对「图里没有植物」和「区系不存在」都回 404，按返回体区分，别一律说区系错
      const bodyText = `${(json && json.message) || ''} ${txt || ''}`.trim();
      if (/species|not found|no plant|reject/i.test(bodyText) && !/project/i.test(bodyText)) {
        throw new SiteError('Pl@ntNet 没有在这张图里识别到植物（可能主体太小、不是植物，或图片被站方拒绝）', { status: 404 });
      }
      throw new SiteError(`Pl@ntNet 没有「${project}」这个区系，请到设置里换成「自动」或「中国」再试`, { status: 404 });
    }
    if (res.status === 413) throw new SiteError('图片太大：Pl@ntNet 一次最多 50MB', { status: 413 });
    if (res.status === 429) {
      q.remaining = 0;
      q.blockedUntil = (() => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); })();
      throw new SiteError('今天的免费额度用完了（Pl@ntNet 免费版每天 500 次），明天再用或先换别的站', { status: 429, quotaExhausted: true });
    }
    if (!res.ok || !json) {
      throw new SiteError(`Pl@ntNet 返回 ${res.status}${txt ? '：' + txt.slice(0, 120) : ''}`, { status: res.status });
    }

    const left = Number(json.remainingIdentificationRequests);
    if (Number.isFinite(left)) {
      q.remaining = left;
      this.setState('plantnet', true, `剩 ${left} 次`);
      if (left <= 0) q.blockedUntil = (() => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); })();
    }

    // commonNames 跟着 lang 走；只挑中文的，没有就留空（前端会只显示学名）
    const list = Array.isArray(json.results) ? json.results : [];
    const items = list
      .map((r, i) => {
        const sp = r.species || {};
        const cn = (sp.commonNames || []).find((n) => /[\u4e00-\u9fa5]/.test(String(n))) || '';
        return {
          latin: String(sp.scientificNameWithoutAuthor || '').trim(),
          cn: String(cn).trim(),
          score: Number(r.score) || 0,
          rank: i + 1,
        };
      })
      .filter((it) => it.latin);
    if (!items.length) throw new SiteError('Pl@ntNet 没给出候选（画面里可能不是植物）');
    return items;
  }

  /* ---------------- 文浩识蛾 / 识蝶 butterflyai ---------------- */

  async identifyButterfly(img, home) {
    const referer =
      home || 'https://www.butterflyai.cc/static/mothweb/webfiles/about/ai.html';
    const fd = new FormData();
    fd.append('action', 'UploadVMKImagePath');
    fd.append('file', new Blob([img.buffer], { type: img.mime }), img.filename);
    const res = await request('https://www.butterflyai.cc/uploadbut/', {
      method: 'POST',
      headers: { referer, origin: 'https://www.butterflyai.cc' },
      body: fd,
      timeout: 150000,
    });
    if (!res.ok) {
      throw new SiteError(`接口返回 ${res.status}`);
    }
    const json = await res.json();
    const list = Array.isArray(json.info) ? json.info : [];
    const items = list
      .map((it, i) => ({
        latin: (it.latin || '').trim(),
        cn: (it.namecn || it.cn || '').trim(),
        score: Number(String(it.per || '0').replace('%', '')) || 0,
        rank: i + 1,
      }))
      .filter((it) => it.latin);
    if (!items.length) throw new SiteError('未返回候选（可能不是鳞翅目）');
    return items;
  }

  /* ---------------- 自然在线 ecp.ibiodiversity.cn ---------------- */

  xingseCfg() {
    if (!this.config.sites.xingse) this.config.sites.xingse = {};
    return this.config.sites.xingse;
  }

  /** 自然在线用 Bearer 令牌鉴权，单独封装一层；token 传 '' 表示这次不带令牌（登录用） */
  async xingseApi(pathname, { method = 'POST', body, form = false, token } = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      origin: XINGSE_BASE,
      referer: XINGSE_BASE + '/myNature',
    };
    const tk = token === undefined ? this.xingseCfg().token : token;
    if (tk) headers.authorization = 'Bearer ' + tk;

    let payload;
    if (form) {
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json;charset=UTF-8';
      payload = JSON.stringify(body);
    }
    const { res, json } = await requestJson(XINGSE_BASE + pathname, {
      method,
      headers,
      body: payload,
      timeout: 120000,
    });
    if (!json) {
      throw new SiteError(`自然在线接口未返回 JSON（HTTP ${res.status}）`, { status: res.status });
    }
    return json;
  }

  /** 取一张验证码：{ key, image(dataURL) } */
  async getXingseCaptcha() {
    const j = await this.xingseApi('/api/online/authentication/getCaptcha', {
      method: 'GET',
      token: '',
    });
    const d = j.data || {};
    if (j.code !== '00000' || !d.captcha || !d.key) {
      throw new SiteError(j.msg || '验证码获取失败');
    }
    return { key: d.key, image: d.captcha };
  }

  /** 账号密码 + 人工看出的验证码 → 令牌，落盘到 config 里长期复用 */
  async loginXingse(captcha, key) {
    const cfg = this.xingseCfg();
    if (!cfg.username || !cfg.password) {
      throw new SiteError('未配置自然在线账号密码');
    }
    if (!captcha || !key) throw new SiteError('请先获取并填写验证码');

    const j = await this.xingseApi('/api/online/authentication/login', {
      method: 'POST',
      body: { userName: cfg.username, password: cfg.password, captcha, key },
      token: '',
    });
    const d = j.data || {};
    if (j.code !== '00000' || !d.token) {
      throw new SiteError(j.msg || '登录失败');
    }
    cfg.token = d.token;
    cfg.tokenAt = Date.now();
    this.persistConfig?.();
    this.setState('xingse', true, '已登录');
    return true;
  }

  /**
   * 令牌是否还能用（不登录，只探一下用户信息）。
   * 先探内置识别账号：它在，植物识别就是可用的，哪怕用户没登录自己的账号
   * （相册那一块另算，界面上单独提示）。
   */
  async checkXingse() {
    const cfg = this.xingseCfg();
    const share = NATSHARE.token();
    if (share) {
      try {
        const j = await this.xingseApi('/api/online/user/info', { method: 'GET', token: share });
        if (j.code === '00000') {
          this.setState('xingse', true, '内置识别账号可用（相册需自己登录）');
          return true;
        }
      } catch {
        /* 探不通就当内置账号过期，退到用户自己的令牌 */
      }
    }
    if (!cfg.token) {
      this.setState('xingse', false, share ? '内置识别账号已过期，请重新登录你自己的账号' : '待输入验证码');
      return false;
    }
    try {
      const j = await this.xingseApi('/api/online/user/info', { method: 'GET' });
      if (j.code === '00000') {
        this.setState('xingse', true, '已登录');
        return true;
      }
      this.setState('xingse', false, '令牌已失效，请在设置里重新取验证码');
      return false;
    } catch (err) {
      this.setState('xingse', false, '令牌校验失败：' + (err.message || err));
      return false;
    }
  }

  /**
   * 拿到（必要时创建）中转相册的行 ID。
   * slotKey 是「相册 id 记在配置的哪个字段」：内置识别账号用 shareAlbumId，
   * 用户自己的账号用 albumId —— 两本相册属于两个账号，混用会拿 A 的 id 去 B 里找。
   */
  async ensureXingseAlbum(token, slotKey = 'albumId') {
    const cfg = this.xingseCfg();
    const list = await this.xingseApi('/api/online/myNature/album/home', {
      body: { limit: 200, offset: 0 },
      token,
    });
    const recs = list.data?.albumPage?.records || [];
    const hit = recs.find((a) => a.id === cfg[slotKey] || a.title === XINGSE_ALBUM_TITLE);
    if (hit) {
      if (cfg[slotKey] !== hit.id) {
        cfg[slotKey] = hit.id;
        this.persistConfig?.();
      }
      return hit.id;
    }
    const created = await this.xingseApi('/api/online/myNature/album/add', {
      token,
      body: {
        title: XINGSE_ALBUM_TITLE,
        description: '程序识别用的中转相册，里面的照片每识别一张就删一张',
        shareMode: 0,
        useAI: 2, // 关掉站方自动识别，只借它的自然在线接口
        ...XINGSE_ADDR,
        cultivated: 0,
        specimensDeposition: 0,
      },
    });
    if (created.code !== '00000' || !created.data) {
      throw new SiteError(created.msg || '创建中转相册失败');
    }
    cfg[slotKey] = created.data;
    this.persistConfig?.();
    return created.data;
  }

  /**
   * 传图识别。优先用内置识别账号（开箱即用），它失效了再退回用户自己登录的账号。
   * 相册/写回鉴定**不**走这里，那边要的是用户自己的登录态。
   */
  async identifyXingse(img) {
    const share = NATSHARE.token();
    const own = String(this.xingseCfg().token || '');
    if (!share && !own) {
      throw new SiteError('自然在线未登录：请在「账号设置」里获取验证码登录一次', { status: 401 });
    }
    try {
      return await this.xingseIdentifyOnce(img, share || own, share ? 'shareAlbumId' : 'albumId');
    } catch (err) {
      const authFail = err && (err.status === 401 || /登录|令牌|授权|过期/i.test(err.message || ''));
      if (!share || !own || !authFail) throw err;
      console.log('  [i] 内置识别账号不可用（' + (err.message || err) + '），改用本机登录的自然在线账号识别');
      return this.xingseIdentifyOnce(img, own, 'albumId');
    }
  }

  /** 单次识别：用哪张令牌、中转相册 id 记在哪个字段，由调用方决定 */
  async xingseIdentifyOnce(img, token, slotKey) {
    const call = (p, o = {}) => this.xingseApi(p, { ...o, token });
    const albumId = await this.ensureXingseAlbum(token, slotKey);

    // 原图可能几十 MB，自然在线用不到那么大；有前端转好的 JPEG 就优先用它
    const buffer = img.jpeg || img.buffer;
    if (!buffer) throw new SiteError('未拿到图片数据');

    await call('/api/online/myNature/album/photo/uploadBatch/begin', {});
    let photoId = null;
    try {
      const fd = new FormData();
      const type = img.jpeg ? 'image/jpeg' : img.mime || 'image/jpeg';
      const filename = img.jpeg
        ? img.filename.replace(/\.[^.]+$/, '') + '.jpg'
        : img.filename;
      fd.append('file', new Blob([buffer], { type }), filename);
      // 这些字段与站点前端上传时的取值一致，缺一个都会返回 B0001
      const fields = {
        albumId,
        fileType: 1,
        timeZone: '37',
        useAI: 2,
        useBarcode: 0,
        author: '',
        fileTime: Date.now(),
        source: 6,
        deviceModel: '',
        tz: 8,
      };
      for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));

      const up = await call('/api/online/utils/file/upload/album/photo', {
        body: fd,
        form: true,
      });
      const d = up.data;
      photoId = typeof d === 'string' ? d : d?.photoId;
      if (up.code !== '00000' || !photoId) {
        if (/401|登录|令牌/i.test(up.msg || '')) {
          this.setState('xingse', false, '令牌已失效，请在设置里重新取验证码');
        }
        throw new SiteError(up.msg || '上传到自然在线失败', { status: 400 });
      }

      const r = await call('/api/online/myNature/album/photo/identify/xingse', {
        body: { photoId },
      });
      if (r.code !== '00000') throw new SiteError(r.msg || '自然在线识别接口报错', { status: 400 });
      const list = Array.isArray(r.data) ? r.data : [];
      const items = list
        .map((it, i) => ({
          latin: String(it.scientificName || '').trim(),
          cn: String(it.name || '').trim(),
          // 接口给的是 0~1 的概率，统一乘成百分制
          score: Math.round((Number(it.probability) || 0) * 1000) / 10,
          rank: i + 1,
        }))
        .filter((it) => it.latin);
      if (!items.length) throw new SiteError('自然在线未返回候选（可能不是植物）', { status: 400 });
      return items;
    } finally {
      // 不管成没成，中转相册里都不留照片
      if (photoId) {
        try {
          await call('/api/online/myNature/album/photo/deletes', { body: [photoId] });
        } catch {
          /* 清理失败不影响识别结果 */
        }
      }
      try {
        await call('/api/online/myNature/album/photo/uploadBatch/end', {});
      } catch {
        /* 同上 */
      }
    }
  }

  /* ---------------- 豆包（火山方舟视觉理解） ---------------- */

  doubaoCfg() {
    if (!this.config.sites) this.config.sites = {};
    if (!this.config.sites.doubao) this.config.sites.doubao = {};
    return this.config.sites.doubao;
  }

  /** 校验密钥：发一个只要 1 个 token 的最小请求，能通就算连上 */
  async checkDoubao() {
    const cfg = this.doubaoCfg();
    const key = String(cfg.apiKey || '').trim();
    if (!key) {
      this.setState('doubao', false, '待填 API Key');
      throw new SiteError('豆包：还没填火山方舟 API Key', { status: 401 });
    }
    try {
      const { res, json, text } = await requestJson(`${DOUBAO_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model || DOUBAO_MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          thinking: { type: 'disabled' },
        }),
        timeout: 25000,
      });
      if (!res.ok) {
        const msg = res.status === 401 ? 'API Key 无效或已被删除' : arkError(json, res.status, text);
        throw new SiteError(msg, { status: res.status === 401 ? 401 : 400 });
      }
      this.setState('doubao', true, `已连接 ${cfg.model || DOUBAO_MODEL}`);
      return true;
    } catch (err) {
      this.setState('doubao', false, err.message || '连接失败');
      throw err;
    }
  }

  async identifyDoubao(img) {
    const cfg = this.doubaoCfg();
    const key = String(cfg.apiKey || '').trim();
    if (!key) {
      throw new SiteError('豆包未配置：请在「账号设置」里填入火山方舟 API Key', { status: 401 });
    }
    // 方舟只收 10MB 以内的图；前端已经备好一份 JPEG，优先用它
    const buffer = img.jpeg || img.buffer;
    if (!buffer) throw new SiteError('未拿到图片数据');
    if (buffer.length > 9.5 * 1024 * 1024) {
      throw new SiteError('图片超过 10MB，豆包不收这么大的图', { status: 400 });
    }
    const mime = img.jpeg ? 'image/jpeg' : img.mime || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const url = `${DOUBAO_BASE}/chat/completions`;
    const body = (fast) =>
      JSON.stringify({
        model: cfg.model || DOUBAO_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              { type: 'text', text: DOUBAO_PROMPT },
            ],
          },
        ],
        max_tokens: 400,
        temperature: 0.2,
        // 关掉深度思考：开着要推 2000 来字，实测一张图 58 秒；关掉 2.5 秒，且候选更收敛
        ...(fast ? { thinking: { type: 'disabled' } } : {}),
      });

    let { res, json, text } = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: body(true),
      timeout: 120000,
    });
    // 换成不支持 thinking 参数的模型时，去掉该参数再试一次
    if (!res.ok && res.status === 400 && /thinking|unknown field|invalid.*param/i.test(String(text || ''))) {
      ({ res, json, text } = await requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: body(false),
        timeout: 120000,
      }));
    }
    if (res.status === 401) {
      this.setState('doubao', false, 'API Key 失效');
      throw new SiteError('豆包 API Key 无效或已被删除', { status: 401 });
    }
    if (!res.ok) throw new SiteError(arkError(json, res.status, text), { status: 400 });

    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new SiteError('豆包没有返回内容', { status: 400 });

    const parsed = extractJsonObject(content);
    const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const items = list
      .map((c) => {
        const conf = Number(c?.confidence);
        return {
          latin: String(c?.latin || '').trim(),
          cn: String(c?.cn || '').trim(),
          // 自报把握度当分数用，统一成百分制
          score: Math.round(Math.max(0, Math.min(1, Number.isFinite(conf) ? conf : 0.5)) * 1000) / 10,
        };
      })
      .filter((it) => it.latin)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((it, i) => ({ ...it, rank: i + 1 }));

    if (!items.length) {
      throw new SiteError('豆包没给出候选（可能画面里没有生物）', { status: 400 });
    }
    this.setState('doubao', true, `已连接 ${cfg.model || DOUBAO_MODEL}`);
    return items;
  }

  /* ---------------- 快瞳 AI（鸟类） ---------------- */

  ktCfg() {
    return this.config.sites?.kuaitong || {};
  }

  /** 拿令牌：有缓存直接用；force 或过期时用 accessKey/accessSecret 换一张 */
  async kuaitongToken(force = false) {
    const cfg = this.ktCfg();
    if (!force && cfg.token) return cfg.token;
    const ak = String(cfg.accessKey || '').trim();
    const sk = String(cfg.accessSecret || '').trim();
    if (!ak || !sk) {
      throw new SiteError('快瞳未配置：需要 accessKey 和 accessSecret', { status: 401 });
    }
    // 注意：参数名就是 accessKey / accessSecret，换成 key/secret 会返回「缺少请求参数」
    const url = `${KUAITONG_BASE}/s/api/getAccessToken?accessKey=${encodeURIComponent(ak)}&accessSecret=${encodeURIComponent(sk)}`;
    const { res, json, text } = await requestJson(url, { timeout: 25000 });
    const token = json?.data?.access_token;
    if (!token) throw new SiteError(ktError(json, res.status, text), { status: 400 });
    cfg.token = token;
    cfg.tokenAt = Date.now();
    this.config.sites.kuaitong = cfg;
    if (typeof this.persistConfig === 'function') {
      try {
        await this.persistConfig();
      } catch {
        /* 落盘失败不影响本次识别 */
      }
    }
    return token;
  }

  /** 发一张图给指定的鸟类接口（快瞳要 multipart，字段名固定为 file） */
  async ktPost(token, buffer, mime, filename, path) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), filename || 'image.jpg');
    return requestJson(`${KUAITONG_BASE}/s/api/${path}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: fd,
      timeout: 60000,
    });
  }

  /**
   * 选哪个接口：国内鸟种（domesticBirdType，1400+）优先，没开通就退回全球（birdGlobalType）。
   * 探测结果缓存在进程内，免得每张图都白试一次。
   */
  async kuaitongPath() {
    if (this.ktPath) return this.ktPath;
    const token = await this.kuaitongToken();
    let path = 'domesticBirdType';
    try {
      const r = await requestJson(
        `${KUAITONG_BASE}/s/api/domesticBirdType?token=${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeout: 15000 },
      );
      // 402 = 产品权限没开通；其余（如缺图片参数的 400）说明接口是通的
      if (r.res.status === 402) path = 'birdGlobalType';
    } catch {
      path = 'birdGlobalType';
    }
    this.ktPath = path;
    return path;
  }

  async checkKuaitong() {
    const cfg = this.ktCfg();
    if (!cfg.accessKey || !cfg.accessSecret) {
      this.setState('kuaitong', false, '待填密钥');
      throw new SiteError('快瞳：还没填 accessKey / accessSecret', { status: 401 });
    }
    try {
      await this.kuaitongToken(true);
      const path = await this.kuaitongPath();
      this.setState('kuaitong', true, path === 'domesticBirdType' ? '已连接（国内鸟种）' : '已连接（全球鸟种）');
      return true;
    } catch (err) {
      this.setState('kuaitong', false, err.message || '连接失败');
      throw err;
    }
  }

  async identifyKuaitong(img) {
    const buffer = img.jpeg || img.buffer;
    if (!buffer) throw new SiteError('未拿到图片数据');
    if (buffer.length > 1.9 * 1024 * 1024) {
      throw new SiteError('快瞳只收 2MB 以内的图，请先压缩', { status: 400 });
    }
    const mime = img.jpeg ? 'image/jpeg' : img.mime || 'image/jpeg';
    const path = await this.kuaitongPath();

    let out = await this.ktPost(await this.kuaitongToken(), buffer, mime, img.filename, path);
    // 令牌过期就换一张再来一次
    if (out.res.status === 401) {
      out = await this.ktPost(await this.kuaitongToken(true), buffer, mime, img.filename, path);
    }
    const { res, json, text } = out;
    if (!res.ok) throw new SiteError(ktError(json, res.status, text), { status: 400 });

    // 一张图里可能有多只鸟，各给一份 identification：按学名合并，取最高分
    const pets = Array.isArray(json?.data?.pet) ? json.data.pet : [];
    const best = new Map();
    for (const p of pets) {
      for (const it of p?.identification || []) {
        const latin = String(it.scientific_name || '').trim();
        if (!latin) continue;
        const score = Math.round((Number(it.confidence) || 0) * 1000) / 10;
        const prev = best.get(latin);
        if (!prev || score > prev.score) {
          best.set(latin, { latin, cn: String(it.chinese_name || '').trim(), score });
        }
      }
    }
    const items = [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((it, i) => ({ ...it, rank: i + 1 }));

    if (!items.length) {
      throw new SiteError('快瞳没认出鸟（画面里可能没有鸟，或品种不在它的库内）', { status: 400 });
    }
    this.setState('kuaitong', true, '已连接');
    return items;
  }

  /* ---------------- eBird（地区记录核对；不做图片识别，不参与投票） ---------------- */

  ebCfg() {
    return this.config.sites?.ebird || {};
  }

  /** 连接检测：能读到本地区最新一条记录就算通 */
  async checkEbird() {
    if (!String(this.ebCfg().apiKey || '').trim()) {
      this.setState('ebird', false, '待填 API key');
      throw new SiteError('eBird：还没填 API key', { status: 401 });
    }
    try {
      const out = await ebird.ping(this.ebCfg());
      const msg = out.sample
        ? `已连接（${out.regionLabel} · 最近一条是 ${out.sample.cn}）`
        : `已连接（${out.regionLabel}）`;
      this.setState('ebird', true, msg);
      this.ebirdInfo = out;
      return true;
    } catch (err) {
      this.setState('ebird', false, err.message || '连接失败');
      throw err;
    }
  }

  /** 给一批学名查本地区近 14 天记录 */
  async ebirdCheck(sciNames) {
    return ebird.check(this.ebCfg(), sciNames);
  }

  /* ---------------- 懂鸟（HHOLOVE 官方 API） ---------------- */

  dnCfg() {
    return this.config.sites?.dongniao || {};
  }

  dnKey() {
    const key = String(this.dnCfg().apiKey || '').trim();
    if (!key) throw new SiteError('懂鸟未配置 api_key', { status: 401 });
    return key;
  }

  /** 统一发 POST（multipart）。api_key 走 header，和文档一致 */
  async dnPost(fields, timeout = 60000) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v && typeof v === 'object' && v.buffer) {
        fd.append(k, new Blob([v.buffer], { type: v.mime || 'image/jpeg' }), v.filename || 'image.jpg');
      } else {
        fd.append(k, String(v));
      }
    }
    return requestJson(`${DONGNIAO_BASE}/dongniao`, {
      method: 'POST',
      headers: { api_key: this.dnKey() },
      body: fd,
      timeout,
    });
  }

  /** 查剩余次数：不消耗配额，适合当连接检测。三个类群共用一把 key，状态一起刷 */
  async checkDongniao() {
    const setAll = (ok, msg) => {
      for (const g of DONGNIAO_CLASSES) this.setState(g.key, ok, msg);
    };
    if (!this.dnCfg().apiKey) {
      setAll(false, '待填 api_key');
      throw new SiteError('懂鸟：还没填 api_key', { status: 401 });
    }
    try {
      const { res, json, text } = await this.dnPost({ quota: 1 }, 20000);
      const code = Array.isArray(json) ? json[0] : null;
      if (code !== 1000) throw new SiteError(dnError(code, json, res.status, text), { status: 400 });
      const q = json[1] || {};
      this.dnQuota = q;
      const left = Number(q.remaining ?? q.image?.remaining);
      const total = Number(q.total ?? q.image?.total);
      const msg = Number.isFinite(left)
        ? total === -1
          ? '已连接（不限次数）'
          : `已连接（剩余 ${left} 次）`
        : '已连接';
      setAll(true, msg);
      return true;
    } catch (err) {
      setAll(false, err.message || '连接失败');
      throw err;
    }
  }

  async identifyDongniao(img, cls = 'B') {
    const clsMeta = DONGNIAO_CLASSES.find((g) => g.cls === cls) || DONGNIAO_CLASSES[0];
    const taxon = clsMeta.short.replace(/^懂鸟·/, '');
    const buffer = img.jpeg || img.buffer;
    if (!buffer) throw new SiteError('未拿到图片数据');
    if (buffer.length > 2 * 1024 * 1024) {
      throw new SiteError('懂鸟只收 2MB 以内的图，请先压缩', { status: 400 });
    }
    const mime = img.jpeg ? 'image/jpeg' : img.mime || 'image/jpeg';

    // 1) 提交任务，拿 resultid
    let out = await this.dnPost({
      image: { buffer, mime, filename: img.filename },
      upload: 1,
      class: cls, // B 鸟 / M 兽 / AR 两栖爬行
    });
    let code = Array.isArray(out.json) ? out.json[0] : null;
    if (code === 1005) {
      // api_key 不存在 / 被禁用 / 用了 web_token
      throw new SiteError(dnError(code, out.json, out.res.status, out.text), { status: 401 });
    }
    if (code !== 1000) {
      throw new SiteError(dnError(code, out.json, out.res.status, out.text), { status: 400 });
    }
    const resultId = String(out.json[1] || '');
    if (!resultId) throw new SiteError('懂鸟没返回识别 ID', { status: 400 });

    // 2) 轮询结果：文档建议 1~3 秒一次、限定次数，最多等约 12 秒
    let payload = null;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 900 : 1500));
      out = await this.dnPost({ resultid: resultId }, 25000);
      code = Array.isArray(out.json) ? out.json[0] : null;
      if (code === 1000) {
        payload = out.json[1];
        break;
      }
      if (code === 1001) continue; // 还没算完
      throw new SiteError(dnError(code, out.json, out.res.status, out.text), { status: 400 });
    }
    if (!payload) throw new SiteError('懂鸟识别超时（等了 12 秒还没出结果）', { status: 400 });
    if (!Array.isArray(payload)) {
      throw new SiteError(`懂鸟返回异常：${String(payload).slice(0, 80)}`, { status: 400 });
    }

    // 3) 一张图可能有多只鸟，每个目标一份 list；按学名合并取最高分
    const best = new Map();
    for (const target of payload) {
      for (const it of target?.list || []) {
        if (!Array.isArray(it)) continue;
        // 置信度两种口径都见过：图像接口直接给百分数（97.6），语音接口给 0~1，统一成 0~1
        const raw = Number(it[0]);
        const conf = !Number.isFinite(raw) ? 0 : raw > 1 ? raw / 100 : raw;
        // 第二项是「中文名|英文名|拉丁名」，不保证三段都在
        const parts = String(it[1] || '').split('|');
        const latin = String(parts[2] || '').trim();
        const cn = String(parts[0] || '').trim();
        if (!latin && !cn) continue;
        const key = latin || cn;
        const score = Math.round(conf * 1000) / 10;
        const prev = best.get(key);
        if (!prev || score > prev.score) best.set(key, { latin, cn, score });
      }
    }
    const items = [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((it, i) => ({ ...it, rank: i + 1 }));

    if (!items.length) {
      throw new SiteError(`懂鸟没认出来（这个站点只认${taxon}）`, { status: 400 });
    }
    for (const g of DONGNIAO_CLASSES) this.setState(g.key, true, '已连接');
    return items;
  }

  /* ---------------- 百度智能云（动物 / 植物） ---------------- */

  /** 只换 token 验密钥，不识别、不耗额度 */
  async checkBaidu(key) {
    const kind = key === 'baidu-plant' ? 'plant' : 'animal';
    const cfg = this.config.sites?.[key] || {};
    try {
      await baidu.check(kind, cfg);
      this.setState(key, true, '已连接（密钥可用）');
      return true;
    } catch (err) {
      this.setState(key, false, err.message || '连接失败');
      throw err;
    }
  }

  /* ---------------- 统一入口 ---------------- */

  /** 多个分组并发识别时只登录一次 */
  async ensureDuoshiLogin() {
    if (this.jars.duoshi.size() > 0) return true;
    if (!this.duoshiLoginPromise) {
      this.duoshiLoginPromise = this.loginDuoshi().finally(() => {
        this.duoshiLoginPromise = null;
      });
    }
    return this.duoshiLoginPromise;
  }

  async identify(key, img) {
    const t0 = Date.now();
    const meta = SITE_META[key] || {};
    const runOnce = async () => {
      if (meta.account === 'duoshi') {
        await this.ensureDuoshiLogin();
        return this.identifyDuoshi(img, meta.predictGroup);
      }
      if (key === 'inaturalist') return this.identifyINat(img);
      if (key === 'xingse') return this.identifyXingse(img);
      if (key === 'doubao') return this.identifyDoubao(img);
      if (key === 'kuaitong') return this.identifyKuaitong(img);
      if (meta.account === 'dongniao') return this.identifyDongniao(img, meta.dongniaoClass || 'B');
      if (key === 'baidu-animal') return baidu.identify('animal', this.config.sites['baidu-animal'] || {}, img);
      if (key === 'baidu-plant') return baidu.identify('plant', this.config.sites['baidu-plant'] || {}, img);
      if (meta.path) return this.identifyQuarryman(img, meta.path);
      if (key === 'iplant') return this.identifyIPlant(img);
      if (key === 'plantnet') return this.identifyPlantnet(img);
      if (key === 'butterflyai' || key === 'butterflyai-butterfly') {
        return this.identifyButterfly(img, meta.home);
      }
      throw new SiteError('未知站点');
    };

    try {
      let items;
      try {
        items = await runOnce();
      } catch (err) {
        // 网络抖动 / 5xx 重试一次，认证类错误不重试
        const transient = !err.status || err.status >= 500 || /fetch failed|timeout|aborted|ECONN/i.test(err.message || '');
        if (!transient) throw err;
        await new Promise((r) => setTimeout(r, 800));
        items = await runOnce();
      }
      if (key === 'inaturalist') this.setState('inaturalist', true, '已登录');
      return { site: key, ok: true, ms: Date.now() - t0, items };
    } catch (err) {
      return {
        site: key,
        ok: false,
        ms: Date.now() - t0,
        error: err.message || String(err),
        status: err.status,
        items: [],
      };
    }
  }
}

/** 从模型回复里挖出第一个 JSON 对象（可能带 ``` 包裹、前后有废话） */
function extractJsonObject(text) {
  const s = String(text || '').replace(/```[a-z]*/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 把方舟的错误体翻译成一句人话 */
function arkError(json, status, raw) {
  const code = json?.error?.code || '';
  const msg = json?.error?.message || '';
  // 这两类是「账号没开通模型」，最常见，翻译成可操作的提示
  if (code === 'ModelNotOpen' || /has not activated/i.test(msg)) {
    return '方舟：账号还没开通这个模型。请到方舟控制台 →「开通管理」点击开通（有免费额度），开通后立刻可用';
  }
  if (code === 'InvalidEndpointOrModel.NotFound') {
    return '方舟：账号里找不到这个模型 ID，请在设置里换成控制台「开通管理」里列出的名字';
  }
  if (code === 'AuthenticationError' || /api key/i.test(msg) || status === 401) {
    return '方舟：API Key 无效或已被删除，请在设置里重新填写';
  }
  if (status === 429) return '方舟：请求太频繁或免费额度/余额用完了';
  if (status === 403) return '方舟：没有该模型的调用权限，请先在控制台开通';
  if (msg) return `方舟：${msg}`;
  const brief = String(raw || '').replace(/\s+/g, ' ').slice(0, 120);
  return `方舟返回 HTTP ${status}${brief ? '：' + brief : ''}`;
}

/** 把快瞳的错误体翻译成一句人话 */
function ktError(json, status, raw) {
  const msg = json?.message;
  if (status === 402) return '快瞳：这个账号没开通该识别产品，需要联系快瞳客服开通';
  if (status === 401) return '快瞳：令牌过期且续期失败，请检查 accessKey / accessSecret 是否还有效';
  if (status === 400 && /必传/.test(String(msg || ''))) return '快瞳：图片没传上去，请重试';
  if (msg) return `快瞳：${msg}`;
  const brief = String(raw || '').replace(/\s+/g, ' ').slice(0, 120);
  return `快瞳返回 HTTP ${status}${brief ? '：' + brief : ''}`;
}

/** 懂鸟官方 API 的业务码转人话（码表见 https://ai.open.hhodata.com/doc/） */
function dnError(code, json, status, raw) {
  const map = {
    1001: '图片超过 2MB，请先压缩',
    1002: '图片无法解析，或任一边不在 11~8192 像素之间',
    1003: '设备 ID 含非法字符（内部问题）',
    1004: '类别参数错误（内部问题）',
    1005: 'api_key 不存在、已被禁用，或用了网页版 web_token',
    1006: '这个 api_key 绑定了 IP 白名单，当前网络不在名单内',
    1007: '触发限流（每分钟 60 次），稍等再试',
    1008: '图片里没检测到目标框',
    1009: '地区编码无效',
    1010: '图片里没识别出动物（懂鸟只认动物：植物、真菌、风景都会落到这一条）',
    1011: '识别到的物种不在指定地区的分布范围内',
  };
  if (map[code]) return `懂鸟：${map[code]}`;
  if (status >= 500) return `懂鸟服务端异常（HTTP ${status}），稍后再试`;
  const brief = Array.isArray(json) ? json[1] : String(raw || '');
  return `懂鸟返回 ${code ?? 'HTTP ' + status}${brief ? '：' + String(brief).slice(0, 80) : ''}`;
}

module.exports = { Sites, SITE_META };
