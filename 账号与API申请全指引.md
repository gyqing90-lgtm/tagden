# 账号与 API 申请全指引

> 适用：**物种标注工坊 tagden v0.6.20** / **物种鉴定聚合台 v1.0.51**
> 用途：接手人重新申请、轮换各站点账号与 API Key 时照着做。
> **当前所有凭据已经加密内置在 `lib/seed.js`，普通用户不需要申请任何东西** —— 这份文档是给「要换账号 / 要自己重新开通」的维护者看的。
> 本文档**不含任何真实账号、密码、Key 的值**；申请到的值一律存进 `lib/seed.js`（加密）或本机 `data/config.json`，不要写进文档、日志、聊天记录。

---

## 0. 一张表看全：23 个站点，哪些要申请

程序里一共 23 个站点条目，但**识别相关只有 9 套凭据** —— 很多站点共用一个账号（多识三个分组共用一份登录态，懂鸟三个类群共用一把 key）。下表第 10 行是**发版用的 OSS 密钥**，不算识别站点。

| # | 凭据 | 服务的站点条目 | 类型 | 要不要钱 | 谁申请 |
|---|---|---|---|---|---|
| 1 | 多识 `duoshi` | `duoshi` / `duoshi-bird` / `duoshi-plant` | 账号 + 密码 | 免费（看站方政策） | 官网注册 |
| 2 | iNaturalist | `inaturalist` | 账号 + 密码 | 免费 | 官网注册 + 邮箱验证 |
| 3 | 自然在线 / 形色 | `xingse`（聚合台里叫「形色」） | 账号 + 密码 + 图形验证码 → token | 免费 | 官网注册，**验证码必须人眼看** |
| 4 | Pl@ntNet | `plantnet` | API Key | 免费 500 次/天 | my.plantnet.org |
| 5 | 豆包（火山方舟） | `doubao` | API Key + 模型 ID | 按量计费 ≈ 1 分/张 | 火山引擎控制台，需实名 |
| 6 | 快瞳 | `kuaitong` | accessKey + accessSecret | 有免费体验次数，之后按量 | AI 开放平台注册，国内模型需联系客服 |
| 7 | 懂鸟 HHOLOVE | `dongniao` / `-mammal` / `-herp` | API Key | 送 50 次，之后按量 | ai.open.hhodata.com |
| 8 | eBird | `ebird`（地区记录校验，不是识别） | API Key | **永久免费** | ebird.org/api/keygen |
| 9 | 百度智能云 | `baidu-animal` / `baidu-plant` | API Key + Secret Key | 各有免费额度，超出按次 | 百度智能云，需实名 + 建应用 |
| 10 | 阿里云 OSS | 发版用，不是识别站点 | RAM 子账号 AK | 存储/流量计费 | 阿里云 RAM 控制台 |

**完全不用申请的 9 个**：晓虫 6 组（昆虫 / 植物 / 菌物 / 蛇 / 贝类 / 月季，`quarryman.cn`）、植物智 iPlant（`iplant.cn/stu/20k`）、文浩识蛾 / 识蝶（`butterflyai.cc`）。它们本来就是匿名接口；**失效时没有「重新申请」这回事**，只能等站方恢复或改代码换接口。

**也不用申请的**：GBIF（`api.gbif.org/v1`，`lib/gbifds.js` 查某属在本地区的分布）、《中国生物物种名录》中文名索引（`public/colcn.bin`，纯本地文件）。

> 聚合台包里另有一份 `API申请与开通指引.md`，记录了懂鸟 / eBird / 百度 / 快瞳当年实际开通时的详细过程、话术和费用，本文第 2 节给的是精简可复现版，两份对照看。

---

## 1. 登录类：账号 + 密码

### 1.1 多识 duoshi.bio

- 官网：<https://duoshi.bio/#/>（单页应用，注册/登录入口在页面右上角）
- 拿到：**用户名 + 密码**
- 填到：`config.sites.duoshi` 的 `username` / `password`，或界面「账号设置 → 多识」
- 程序怎么用它：`POST https://duoshi.bio/api/auth/login` 换 cookie；**动物 / 鸟 / 植物三个分组共用同一个 cookie 容器**（`jar:'duoshi'`），填一次三行一起亮
- 坑：
  - 三个分组前端互斥（同一网站一次只跑一个模型），别以为要三个账号
  - 种子里 `duoshi` 还留着一个历史 `apiKey` 字段，**当前代码不用它**，不用填
  - 登录态会过期，程序会自动重登；若站方改了登录接口，只能抓包改 `lib/adapters.js::loginDuoshi()`
  - 官网若改成邀请码 / 手机号注册，用真实浏览器走一遍注册，别在命令行里硬试

### 1.2 iNaturalist

- 官网：<https://www.inaturalist.org/> → `Sign up`
- 拿到：**登录邮箱 + 密码**（密码至少 6 位，建议密码管理器生成）
- 必做：**去邮箱点验证链接**，没验证的账号登不进去
- 填到：`config.sites.inaturalist` 的 `username`（这里是邮箱）/ `password`
- 程序怎么用它：模拟网页登录 —— 先取登录页的 `authenticity_token`，再 `POST /session` 拿 cookie，最后访问 `/users/api_token` 换一个 JWT（程序缓存 20 小时）
- 坑（最容易踩）：
  - **用 Google / Apple 等第三方注册、没设过密码的账号，程序登不了**。必须在 iNat 账号设置里设一个密码
  - **不需要创建 OAuth 应用**（那是给上传观察 / 改数据用的；本程序只读公开数据和视觉模型）
  - 账号若开了两步验证，网页表单登录会失败，换一个没开 2FA 的专用账号
  - 「检索地区」只影响结果里 `iNat` / `PPBC` 两个跳转按钮，**不影响识别**，在主界面改，不在账号设置里

### 1.3 自然在线 / 形色 ecp.ibiodiversity.cn

> 同一个站点，聚合台里叫「形色」，tagden 里叫「自然在线（植物识别）」。
> **v0.6.20 起是两套账号，别混**：识别用包里内置的 `natureShare`，相册 / 写回鉴定用用户自己的登录态。

- 官网：<https://ecp.ibiodiversity.cn/myNature>
- 拿到：**账号 + 密码**，再加每次登录时的一枚**图形验证码**
- 登录流程（程序界面已做好，不用写代码）：「自然在线」页 → 填账号密码 → 点获取验证码 → **人眼看图输入** → 登录 → 换到 token，加密存 `data/nature-token.json`
- 为什么必须人工：验证码是图片，站方不给机器识别，任何「自动登录」都不做
- 填到：界面登录即可，**不要**把用户自己的账号写进 `lib/seed.js`（那会让所有人共用一个相册）
- 内置识别账号要换令牌时：
  ```bash
  node tools/reseal-share.js                       # 借本机 data/config.json 里的账号和令牌重封
  node tools/reseal-share.js --user 138xxxx --pass '密码' --token 'eyJ0eXAi...'
  node tools/reseal-share.js --dry                # 只看效果，不写文件
  node build-exe.js 0.6.21                        # 重封后必须重新打包发布，否则线上还是旧令牌
  ```
- 坑：
  - 令牌会过期。内置令牌失效时识别会**自动退回用户自己登录的令牌**，两个都没有才提示未登录
  - 识别用的中转相册 id 存 `config.sites.xingse.shareAlbumId`，用户相册 id 存 `albumId`，**两个不能混**
  - 退出相册登录**不会**退出识别，文案已经写清楚

---

## 2. API Key 类

### 2.1 Pl@ntNet（植物，推荐先申请这个）

| 步 | 做什么 |
|---|---|
| 1 | 打开 <https://my.plantnet.org/> → Create a free account |
| 2 | 填邮箱、验证邮箱 |
| 3 | 进账户 / settings 页，复制 **API Key** |
| 4 | 填进「账号设置 → Pl@ntNet → API Key」，点「保存并登录」 |

- 免费额度：**500 次识别 / 天**，UTC 午夜重置，超额返回 HTTP 429，**不会扣费**
- 免费版允许商用（只要不超过 500/天）；**一人或一个组织只能有一个免费账号**，同 IP 多开会被封
- 教育 / 科研 / 非营利可申请 500–10000 次/天（需在页面说明用途、要求挂 "Powered by Pl@ntNet" 标识）；企业超过 500/天要买 Pro 合约
- 一次请求带 1–5 张同一植物的图**只算一次**；`/languages`、`/projects` 这类查询不占额度
- 程序里还有个「区系」选项：`k-china`（中国 3.4 万种）、`k-world-flora`（世界 7.3 万种）、`all`（自动）等。选「中国」只认本土野生种，园艺栽培种容易认不出，换回 `all` 或世界区系
- 只认维管植物，虫 / 鸟 / 真菌不归它管

### 2.2 豆包 · 火山方舟（AI 语义评分 / 补中文名）

| 步 | 做什么 |
|---|---|
| 1 | 注册火山引擎 <https://www.volcengine.com/>，完成**实名认证**（个人即可） |
| 2 | 控制台搜「方舟」→ 进入 <https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey> |
| 3 | 「创建 API Key」，起个名字，**当场复制保存**（Secret 通常只显示一次） |
| 4 | 在「在线推理 / 模型」里确认要用的视觉模型已开通；未开通点「立即开通」 |
| 5 | 填进「账号设置 → 豆包」的 `apiKey`；`model` 留空即用默认 `doubao-seed-2-1-pro-260915` |

- 程序调的是 `https://ark.cn-beijing.volces.com/api/v3`，**`model` 字段要填模型名，不要填 `ep-xxxxxx` 推理接入点 ID**（那是旧版接入方式，本程序用 /api/v3 直接指定模型）。若接口报「模型不存在」，去控制台核对模型名或换一个已开通的视觉模型
- 按 token 计费，识别一张约 1 分钱；在控制台「费用中心 → 用量」看消耗
- 环境变量 `BIOID_ARK_BASE` 可改接口地址（一般不用动）
- 这个站点是「一次性」的：AI 语义评分 / 补中文名才调，普通识别不选它就不花钱

### 2.3 懂鸟 · HHOLOVE 官方 API

| 步 | 做什么 |
|---|---|
| 1 | 打开 <https://ai.open.hhodata.com/> → 注册（邮箱 + 密码，**无验证码**） |
| 2 | 登录后自动进 `/dashboard/keys/`「API Key 管理」 |
| 3 | 点 key 右边的复制图标拿完整值 |
| 4 | 填进「账号设置 → 懂鸟 → apiKey」，点「保存并登录」 |

- 鸟 / 兽 / 两爬三个站点**共用这一把 key**，填一次三行一起亮；状态会显示剩余次数（这个查询不消耗额度）
- 费用：注册送 **图像 50 次 + 语音 300 秒**；之后 200 元 / 1 万次（0.02 元/次）或按量 10 元/千次。**50 次只够测试**，多人共用要充值
- 三个坑：① 建 key 时**别勾 IP 白名单**（换网络就报 `1006 Key not in whitelist`）；② 限流 60 次/分钟；③ 图片 ≤ 2 MB，程序会自动压，报 `1001` 说明原图太大
- 走的是官方开放平台，**不要**去逆向 dongniao.net 网页版（有反爬，且属于绕过风控）

### 2.4 eBird（免费、即时、不用审核）

| 步 | 做什么 |
|---|---|
| 1 | 注册 <https://ebird.org/>（或 <https://secure.birds.cornell.edu/cassso/account/create>） |
| 2 | **去邮箱点验证链接** |
| 3 | 保持登录，打开 <https://ebird.org/api/keygen> |
| 4 | 填 Application / Project Name（如「物种鉴定聚合台」）与一句用途说明 |
| 5 | 勾条款 → **Generate**，立刻显示 key，**永久免费、无需审核** |

- 它**不能识别图片**（那是 Merlin，不开放接口）。程序拿它做校验层：识别出某个鸟种后，查「某地区近 N 天有没有记录」，帮助判断是不是罕见种误判
- 地区码：中国 `CN`，上海 `CN-31`，福建 `CN-35`，广东 `CN-44`；在**站点条上点 eBird** 弹窗里改，不在账号设置里
- 坑：`ebird.org` 的 keygen 页挂了 Anubis 反爬（要求浏览器做 JS 工作量证明），**必须用真实浏览器**，curl / 命令行会失败；`api.ebird.org` 本身可直连
- 同一账号重复提交表单返回的是同一把 key

### 2.5 百度智能云 · 动物识别 / 植物识别

| 步 | 做什么 |
|---|---|
| 1 | 登录 <https://console.bce.baidu.com/>，完成**实名认证** |
| 2 | 「产品服务 → 人工智能 → 图像识别」→ **创建应用** |
| 3 | 应用里勾上「动物识别」「植物识别」两个接口（勾哪个才能调哪个） |
| 4 | 应用列表里拿 **API Key** + **Secret Key** |
| 5 | 填进「账号设置 → 百度·动物 / 百度·植物」各自两个框 |

- 程序用 AK/SK 换 `access_token`（`client_credentials`，30 天有效），**token 只在内存里、不落盘**，重启重换一次且不花额度
- 动物和植物是**两个独立产品、各自计费**，可以同一个应用勾两个接口（那就共用一组 AK/SK），也可以分开建
- 免费额度按接口分别给，超出返回 `error_code 17/19`（程序提示「今天调用量超限」）
- 坑：① 只返回**中文名**，不给学名（植物接口额外用 `baike_num=1` 从百科描述里抠）；② 认不出返回 `"非动物"` / `"非植物"` 而不是空数组；③ `advanced_general`（通用物体）是另一个产品，没开通会报 `error_code 3 Unsupported openapi method`，别误判成 key 错了

### 2.6 快瞳 AI（鸟类）

| 步 | 做什么 |
|---|---|
| 1 | 打开 <https://www.inspirvision.cn/> →「注册试用」，或 <https://inspirvision.cn/spa/aiPlatform/> |
| 2 | 首页 → AI 服务 → 图像识别 → **领取免费体验次数**（常见是 250 次） |
| 3 | 在开放平台的应用 / 密钥页拿 **accessKey**（形如 `APPID_…`）与 **accessSecret** |
| 4 | 填进「账号设置 → 快瞳」两个框，点「保存并登录」 |

- 程序会自动用这两个密钥换 token 并在失效后续期（`config.sites.kuaitong.token` / `tokenAt`），**不用手工填 token**
- 只认鸟类，非鸟图片会提示「没认出鸟」
- **国内鸟种模型要单独找客服开通**：默认用全球模型，国内模型 `domesticBirdType` 返回 402 时程序自动退回全球模型。全球模型会把喜鹊判成北美 *Pica hudsonia*。联系客服时说明「高校观鸟社团、手机照片辅助识别、非商业用途，想开通国内鸟种模型」，并把 accessKey 报给对方。开通后**不用改代码**
- 聚合台包内 `API申请与开通指引.md` 第四节有当时用的完整话术

### 2.7 GBIF（不用申请）

`https://api.gbif.org/v1` 是公开只读接口，`lib/gbifds.js` 直接查某属在本地区的分布，**不需要 key、不需要注册**。若想申请更高配额或注册 GBIF 用户，去 <https://www.gbif.org/>，但对本程序没必要。

---

## 3. 发版用：阿里云 OSS 与 RAM 子账号 AK

> 这一节不是识别站点，但**接手人要继续给用户发更新，必须有它**。
> 桶：`bioidhub-fsw`，地域 `oss-cn-hangzhou`；聚合台在**桶根**，tagden 在 **`tagden/`** 前缀下。

### 3.1 已有桶的情况（推荐）

不用重新开桶。让原账号持有人在 **RAM 访问控制**里建一个专用子账号：

1. RAM 控制台 → 用户 → **创建用户**（如 `bioidhub-publisher`），访问方式勾「**永久 AccessKey**」
2. **创建时立刻复制 AccessKey ID / Secret**（Secret 只显示一次）
3. 新建自定义权限策略，只授这个桶：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject", "oss:GetObject", "oss:DeleteObject",
        "oss:ListObjects", "oss:GetObjectAcl", "oss:PutObjectAcl",
        "oss:AbortMultipartUpload", "oss:ListParts"
      ],
      "Resource": [
        "acs:oss:*:*:bioidhub-fsw",
        "acs:oss:*:*:bioidhub-fsw/*"
      ]
    }
  ]
}
```

4. 把策略挂给这个 RAM 用户；若要让它在 OSS 控制台里能看到桶列表，再单独加一条 `oss:ListBuckets` / `Resource: acs:oss:*:*:*`
5. 把新 AK 写进项目根的 `oss.config.json`：

```json
{ "bucket": "bioidhub-fsw", "region": "oss-cn-hangzhou", "akId": "LTAI…", "akSecret": "…" }
```

或用环境变量（优先级更高，适合 CI）：`OSS_BUCKET` / `OSS_REGION` / `OSS_AK_ID` / `OSS_AK_SECRET`（可选 `OSS_ENDPOINT`）。

> `tools/publish-oss.js` 会做 PUT（上传）、GET（回读清单）、HEAD（校验）、同桶 COPY（覆盖固定别名），所以 `GetObject + PutObject` 必须都有；`oss-clean.js` 清旧版还需要 `DeleteObject` + `ListObjects`。
> 日志桶 `bioidhub-logs` 是另一个桶，若要跑 `tools/oss-log.js setup`，需原账号做一次配置或另授权限。

### 3.2 换 AK 时的铁律

- **只换 AK 不用改 `update.json`**，用户完全无感 —— 发布脚本读的是 `oss.config.json`，客户端读的是编译进 exe 的更新地址，两者互不相关
- 反过来：**换桶 / 换域名 / 换前缀必须改 `update.json`，而一改，所有已装用户就收不到更新了**（URL 被 `build-exe.js` 写进 exe）。所以交接后继续发版请**继续用同一个桶、同一个地址**，详见两份 `交接说明.md` 的「继续发版四条硬约束」
- 桶欠费、AK 被禁用、OSS 到期，发布脚本会报 403 / 404，客户端的自动更新也就停了

---

## 4. 拿到凭据之后：怎么填进去

### 4.1 三种入口（优先级从低到高）

| 入口 | 适用场景 | 会不会发给所有用户 |
|---|---|---|
| 界面「账号设置」逐行填 | 本机临时换账号、测试新 key | 否，只存本机 `data/config.json`（加密） |
| `tools/seal.js` 重封 `lib/seed.js` | **要让所有新装用户开箱即用** | 是，必须重新打包发布 |
| 环境变量 `OSS_*` | 只给发版脚本换 AK | 否，不影响程序 |

### 4.2 重封内置种子

```bash
# ① 先看现在种子里有什么（会打印明文，注意终端历史 / 屏幕录制）
node -e "const s=require('./lib/secure');const v=s.open(require('./lib/seed')).value;console.log(JSON.stringify(v,null,2))"

# ② 改字段后重新封装（--out 覆盖 lib/seed.js）
node tools/seal.js --out lib/seed.js '{"port":7801,"sites":{"plantnet":{"apiKey":"新key"}}}'

# ③ 重新打包发布，否则线上 exe 里还是旧值
node build-exe.js 0.6.21
node build-mac.js 0.6.21
node tools/publish-oss.js --with-mac --verify
```

> ⚠️ **不要动 `lib/secure.js` 里的 `SHARDS`**。一旦换了主密钥分片，旧的 `data/config.json` 和旧的 `seed.js` 全部解不开，所有用户必须重填账号。真要换，必须同步重封种子并提前通知用户。

### 4.3 字段对照（`config.sites.<key>`）

| 站点 key | 必填字段 | 选填 |
|---|---|---|
| `duoshi` | `username`, `password` | `predictGroup` |
| `inaturalist` | `username`（邮箱）, `password` | `place`, `placeId`, `ppbcFor`（界面里选，不用手填） |
| `plantnet` | `apiKey` | `project`（`all` / `k-china` / …） |
| `doubao` | `apiKey` | `model` |
| `kuaitong` | `accessKey`, `accessSecret` | `token`, `tokenAt`（程序自动维护） |
| `dongniao` | `apiKey` | — |
| `ebird` | `apiKey` | `region`（默认 `CN-31`） |
| `baidu-animal` / `baidu-plant` | `apiKey`, `secretKey` | — |
| `xingse` | 用户态：界面登录 | `natureShare`（顶层键，识别专用）、`shareAlbumId`、`albumId` |

### 4.4 怎么确认申请成功

- 界面：「账号设置」填完点「保存并登录」，状态变成「已连接」/ 带剩余次数即通过
- 接口：`GET /api/state`（tagden）或 `/api/status`（聚合台），看对应站点的 `ready`
- 发布链路：`node tools/publish-oss.js --verify` 会回读清单并 HEAD 校验，全绿才能算发完
- **浏览器端永远拿不到明文**：回给前端的只有 `hasApiKey`、`hasPassword` 这类布尔值

---

## 5. 免登录站点清单（不用申请，也申请不了）

| 站点条目 | 官网 | 说明 |
|---|---|---|
| `quarryman` | <https://www.quarryman.cn/insect> | 晓虫昆虫，19178 个单元 |
| `quarryman-plant` / `-fungi` / `-snake` / `-mollusk` / `-rose` | <https://www.quarryman.cn/> | 晓虫其余 5 组，同站不同模型 |
| `iplant` | <https://www.iplant.cn/stu/20k> | 中科院植物所 20150 种模型，只收 JPG |
| `butterflyai` / `butterflyai-butterfly` | <https://www.butterflyai.cc/> | 文浩识蛾 / 识蝶 |

这些站点在 `SITE_META` 里是 `auth: 'none'`，程序直接调匿名接口。**没有账号、没有 Key、没有配额**，站方改接口或下线时，只能改 `lib/adapters.js` 里对应的请求代码，或者暂时在界面里把它关掉。

---

## 6. 常见坑速查

| 现象 | 原因 / 处理 |
|---|---|
| 懂鸟报 `1006 Key not in whitelist` | 建 key 时勾了 IP 白名单，换网络就失效；重建一把不绑白名单的 |
| Pl@ntNet 报 429 | 当天 500 次用完，UTC 午夜重置；教育用途可申请提额 |
| 百度报 `error_code 17/19` | 免费额度用完；报 `error_code 3` 是接口没开通，不是 key 错 |
| 火山方舟报「模型不存在」 | `model` 填成了 `ep-xxx` 推理接入点 ID，或该模型没在控制台开通；填模型名 |
| 快瞳国内模型 402 | 未开通，程序已自动退回全球模型；要开通得联系客服 |
| iNaturalist 一直登不上 | 用第三方注册没设密码 / 没验证邮箱 / 开了两步验证 |
| eBird keygen 打不开或 curl 失败 | 页面挂了 Anubis 反爬，用真实浏览器 |
| 自然在线识别全部提示未登录 | 内置令牌过期了，跑 `tools/reseal-share.js` 重封再发版 |
| 换了 `secure.js` 的 SHARDS 后全站失效 | 旧配置和旧种子解不开了，必须同步重封种子并通知用户重填 |
| 换了 AK 之后用户收不到更新 | 多半是同时改了 `update.json`；AK 和桶不该动更新地址 |

---

## 7. 哪些步骤只能真人做（程序代办不了）

- **实名认证**：火山引擎、百度智能云、阿里云 OSS
- **邮箱验证**：iNaturalist、eBird、Pl@ntNet
- **图形 / 短信验证码**：自然在线登录、部分平台注册
- **付费与充值**：懂鸟、豆包、百度、快瞳、OSS 续费
- **人工审核 / 客服沟通**：快瞳国内鸟种模型开通、Pl@ntNet 教育提额、eBird 表单
- **阿里云主账号操作**：创建 RAM 子账号、改桶权限、配置日志、续费 —— 接手人拿到的只是「发布权」，不是账号本身

---

*整理于 2026-11-08，对应 tagden v0.6.20 / 聚合台 v1.0.51。站方页面和资费会变，以官网当时显示为准；改了代码或换了申请流程记得同步更新本文。*
