# tagden · 物种标注工坊

本地批量图片识别 → 人工确认 → 物种名写回图片元数据。
零依赖 Node（不装任何 npm 包），只监听 127.0.0.1，不上传统计或遥测；识别时只把图片按需发给你勾选的站点，统计页的行政区划是内置离线索引（[GeoNames](https://www.geonames.org/)，CC BY 4.0），不联网。

```
node server.js               # 端口 7801，自动开浏览器
node server.js --no-open     # 不自动开浏览器
node server.js --port 8080   # 换端口
node server.js --hub 8791    # 只认这个聚合台端口（不写则依次探 8791 / 8899 / 8792）

node build-exe.js            # 打单文件 exe（补丁号 +1），产物在同目录
```

开发/回归命令（Node 22+，不需要 `npm install`）：

```bash
npm start        # 等同 node server.js
npm run check    # 全量 node --check（server.js + lib/ + public/ + build/ + tools/）
npm test         # node:test 回归：合并、名录、加解密、版本比较、签名、增量补丁、离线行政区划、识别缓存、打包清单

TAGDEN_NO_LOGIN=1 npm start      # 跳过启动时对 iNaturalist / 多识的静默登录
TAGDEN_NO_GEOCODE=1 npm start    # 统计页连本地行政区划标签也不加，只用文件夹名
npm run regions                  # 重新生成 public/regions.bin（需联网下载 GeoNames 数据）
npm run canary                   # 真实站点冒烟（免费站点；需 data/config.json 或内置种子）
npm run canary -- --self-test    # 只检查素材/站点表，不联网（CI 用）
npm run canary -- --all          # 连付费/可选站点一起跑（会消耗额度）

# Windows 冒烟（在 Windows 上跑，不碰真实 data/）：
powershell -ExecutionPolicy Bypass -File .\tools\smoke-win.ps1 -Exe .\tagden-0.6.25.exe
```

发布签名（首次发版前做一次）：

```bash
npm run keygen    # 生成 ~/.tagden/update-signing-key.pem（私钥，别进仓库）和 update-pubkey.pem（公钥）
npm test          # 28 项回归
npm run build:win -- 0.6.25
npm run build:mac -- 0.6.25
npm run sign      # 给 dist/latest.json 与 dist-mac/latest-mac.json 签名
npm run publish   # 上传并回读校验；配了公钥后，未签名/验签失败的清单会被拒绝
# 发布凭据在仓库外：~/.tagden/oss.config.json，或 --config / OSS_CONFIG / OSS_* 环境变量
```

## 目录

```
tagden/
├── server.js          HTTP 服务 + 目录浏览 + 识别调度 + 写回
├── 物种标注工坊.exe    ★ 打包产物（单文件，不装 Node 也能跑）
├── build-exe.js       ★ 打包脚本（SEA + postject，和聚合台同一套路）
├── build/bundle.js    ★ 极简打包器：模块合成一个 CJS，public/ 内联成字符串
├── .build-tools/      postject（只在打包时用，运行时不依赖）
├── .version           当前版本号（build-exe.js 每次 +1）
├── start.bat          Windows 双击启动（内容与 run.bat 相同）
├── run.bat            同上，纯英文文件名备用
├── lib/
│   ├── adapters.js    ← 从「物种鉴定聚合台」搬来的识别内核（21 个站点）
│   ├── aggregate.js   ← 多站投票合并（原样搬）
│   ├── imgmeta.js     ★ 新写：XMP / PNG iTXt 读写
│   ├── exif.js        ★ 新写：读拍摄时间 / GPS / IFD1 内嵌缩略图
│   ├── labelcache.js  ★ 新写：标签索引缓存（大文件夹秒开的关键）
│   ├── colcn.js       ★ 新写：内置《中国生物物种名录》学名→大陆中文名查表
│   ├── taxonomy.js    学名→界门纲目科属（iNat 优先、GBIF 兜底）
│   ├── assets.js      ★ 新写：静态文件统一入口（源码读磁盘 / exe 读内存）
│   ├── env.js         三个目录的唯一裁决处（源码 / exe / mac 目录版）
│   ├── http.js parse.js inat.js ppbc.js baidu.js ebird.js secure.js
├── public/            index.html / app.js / style.css（打包后内联进 exe）
│                      colcn.bin = 名录索引（gzip，base64 内联进 exe）
├── tools/build-colcn.js  ★ 名录索引构建器（`--download` 自动抓当年分册）
├── data/config.json   加密配置（DPAPI，含各站账号）
└── testpics/          测试图 + 标注记录.csv
```

**exe 放在哪，决定它用哪套配置**：程序读「exe 同级的 `data/`」。放在本目录就接着用你现在这套
（账号不用重填）；单独拷到别的机器上会自动新建空的 `data/`。`TAGDEN_DATA` 环境变量可以指到别处。

打包要点：`build/bundle.js` 里 `MODULES` 列全所有被 require 的本地模块（漏一个运行时就报
「模块未打包」），`ASSETS` 列全 public 下要内联的文件；`lib/assets.js` 在打包模式下**只认内存**，
不回落到磁盘 —— 否则「改了 public 却没生效」会很难查。注 SEA 阶段 postject 会打一句
`warning: The signature seems corrupted!`，正常。

运行期缓存不在上面这个目录里，在 `%LOCALAPPDATA%\tagden\cache`（`labels/` 索引 + `thumbs/` 缩略图），
删掉只会让下次重新扫一遍，不动图片、不动标注记录。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 方案、站点就绪状态、常用位置 |
| GET | `/api/drives` | 所有盘符（`{drives:[{name,path,label,total,free}], labelsPending}`）；卷标由 PowerShell 后台补，`?fresh=1` 绕过缓存 |
| GET | `/api/dirs?path=` | **只列子文件夹**，给左侧树的展开用（不读图片、不 stat，几毫秒） |
| GET | `/api/list?path=` | 列子目录 + 图片（有缓存就直接给大小/标签，没有就先给 `labeled:null`） |
| GET | `/api/labels?path=&from=&n=` | **分窗补读标签**：一窗 120 张，返回大小 + 是否已标注，并顺手把缩略图存进缓存 |
| GET | `/api/label?path=` | 读一张图现有的标签（含原始文件名、方向） |
| GET | `/api/exif?path=` | 拍摄时间 / 经纬度 / 海拔 / 相机型号 / 有没有内嵌缩略图 |
| GET | `/api/hub/link?path=&group=` | 探测聚合台 → `{url}`，URL 里带上 `?img=` `&group=` `&sites=` 当前开着的站点（没起 503 / 版本旧 409） |
| GET | `/img?path=` | 原图字节（带 ETag，`<img>` 直接用） |
| GET | `/img?path=&thumb=1` | **内嵌缩略图**（几 KB）；没有就自动回退原图，回退时没有 `x-thumb` 头 |
| POST | `/api/identify` | `{path, sources[], dataSmall?, dataJpeg?}` → 各站结果 + 合并候选（中文名已换成大陆规范名） |
| POST | `/api/colcn/test` | `{scientificName}` → 内置名录查名自检 `{ok, latin, cn, source, stat}` |
| POST | `/api/write` | `{path, cn, latin, note, source, rename, renameOrder, renamePick, archive}` → 写入并追加 CSV |
| POST | `/api/archive` | `{path, apply}` → 按物种分文件夹；`apply:false` 只统计不动手 |
| POST | `/api/config` | 保存方案 `{preset}` / 模型开关 `{picks:[站点key]}` / 改名开关 / 改名格式 / 归档开关 |
| POST | `/api/export` | `{path}` → 生成明细表 + 物种清单（含拍摄时间、经纬度） |

## 几个实现要点

**为什么前端还要传一份缩小的图**
多识限 640×640，植物智只收 JPEG。服务端没有图像编解码器（零依赖），所以浏览器用
`<canvas>` 生成 `dataSmall`（640px）和 `dataJpeg`（1600px）两份副本一起 POST 上来，
服务端按站点需要取用（`img.small` / `img.jpeg`）。

**XMP 写法（`lib/imgmeta.js`）**
- JPEG：扫段直到 SOS，找 `APP1` 且载荷以 `http://ns.adobe.com/xap/1.0/\0` 开头的那一段；
  有就整段替换，没有就插在最后一个 `APPn` 段之后。单段上限 64KB，超了报错。
- 已有 XMP 时**先删掉 `dc:title` / `dc:description` / `dc:subject` 三个属性再插回去**，
  相机厂商和 Lightroom 写的其它字段（Rating、RAW 参数）原样保留。
- PNG：写 `iTXt`（中文必须用 iTXt，tEXt 是 latin1），插在 `IEND` 之前，自己算 CRC32。
- 写文件走「写临时文件 + rename」，中途断电不会毁原图。

**列表缩略图用 EXIF 里那张现成的小图（`lib/exif.js`）**
相机/手机拍 JPEG 时几乎都会在 IFD1 里塞一张 160×120 左右的小 JPEG（几 KB）。
`/img?thumb=1` 直接把它吐出来，卡片不用再拉几十 MB 的原图。列表接口
`readLabelFast` 只读头 128 KB（若段结构被截断再补读到 1 MB），一次顺带把
orientation 也读出来 —— 缩略图不带方向标记，前端按 6/8 自己转 90°、按 3 转 180°。
没有内嵌缩略图的（截图、部分手机）自动回退原图，行为不变。

**归档与导出都靠「标签 + EXIF」两样东西**
归档：先写标签、再 `rename` 进 `dir/<物种名>/`，所以移动失败也不会丢标注；
批量归档默认 `apply:false` 只返回预览（分组和数量），前端确认后才 `apply:true` 搬。
CSV 永远写在**用户正在浏览的那一层**（`rootDir`），「文件名」列写成 `物种名/文件名`。
导出：扫当前目录 + 一层子目录，用 `readLabel`（标签）+ `EX.meta`（时间/坐标）拼两张表；
描述里的「标注来源：X」「备注」用 `EX.splitDescription()` 反解出来，因为 XMP 里只有一整段描述。

**一千张以上的文件夹：列表只读目录项，其余全后台补（`lib/labelcache.js`）**

E 盘是 USB 机械盘，冷读一个文件头 30 ms、stat 一次 3 ms。2671 张的「鞘翅目」：
逐张读标签要 **83 秒**，就算只 stat 一遍也要 **8.5 秒**。所以列目录只做 `readdirSync`：

- 缓存里有这条 → 直接用（大小、修改时间、是否已标注、方向）；
- 缓存里没有 → `labeled:null`、`size:null`，前端先显示「…」和「—」；
- 前端拿到列表立刻按批 `render`（首批 60 张，之后每帧 150 张），首屏 0.19 秒；
- 再顺序请求 `/api/labels` 一窗窗补，读到就 `patchCard()` 点亮那一张。

几个必须注意的点：

- **`/api/labels` 里不能用 `statSync`**：同步 stat 120 个文件会把事件循环占住，
  用户这时点别的文件夹，`/api/list` 要排队（实测被拖到 1.2 秒）。
- **`readLabelFastAsync` 要有**：`readLabelFast` 是同步的，`await` 一堆同步调用不会并行，
  事件循环照样一个一个等硬盘；异步版走 `fs.promises`，配合 `UV_THREADPOOL_SIZE=16` 才有重叠。
- **补标签时顺手存缩略图**：头已经在内存里，`EX.fromBuffer(head).thumb` 直接写进 `thumbs/`，
  省掉用户滚动时再开一次原图（70 ms → 1.6 ms/张）。`thumb` 设成不可枚举，不进 JSON、不进缓存记录。
- **点一张图不要重渲染**：`S.els`（path → 卡片节点）+ `patchCard()` 只改一张，
  以前每次点击都 `innerHTML` 重建 2671 张卡片，点一下卡近 1 秒。
- 缓存放 `%LOCALAPPDATA%\tagden\cache`（`TAGDEN_CACHE` 可覆盖），不放 OneDrive，避免几十 MB 缩略图同步上云。
- **`.grid` 必须写 `grid-auto-rows: min-content`**：2000+ 张卡片时，`auto` 行高会被算成 4px
  （`.thumb` 的 `aspect-ratio` 在这种规模下不参与行高计算），所有卡片被 `overflow:hidden` 压成细线，
  截图里看就是「一片空白细条」。这个坑排查了很久，别删。
- **外部改动靠 `/api/verify` 纠偏**：列表完全信任缓存，所以缓存超过 1 分钟时前端会再发一次
  `/api/verify`（只 stat + 重读变化的那几张），把徽标/大小改回来；补标签整目录跑完时也算核对过一次。
- **小目录反过来不走缓存**：文件数 ≤ `STAT_UNDER`（200）时列目录直接 stat 一遍再比缓存，
  几十到几百毫秒，换来「刚替换的图」立刻正确。上千张的大目录才用「缓存优先 + 后台核对」。
  这个阈值是拿「用户拿资源管理器替换一张图 → 立刻回来看」这个场景定的。

**左侧文件夹树（2026-10-29 加）**

树的根是盘符，节点懒加载：展开某个节点才 `GET /api/dirs`（一次 `readdir`），
结果放进 `T.kids`，反复折叠不再读盘。几个约定：

- 点 `▸/▾` 只展开折叠，**点名字才打开**；打开后左边这棵树保持原样，只有高亮跟着走
  （以前是「点一下左边就换成子目录」，翻两层就找不到自己在家里的位置）。
- 从地址栏、上方「↑」、或中间文件夹卡片进来时，`revealInTree()` 会逐级读父目录把祖先展开、
  把当前节点滚进视野；路径统一过 `normPath()`（盘符大写 + 反斜杠），
  否则 `e:\a` 和 `E:\a` 会变成树里两个不同的节点。
- `T.kids` 是永久缓存（不随文件夹变化自动失效），所以 rail-head 上有个 `↻`：
  清空缓存 + `?fresh=1` 重拉盘符。插 U 盘、外部建目录后点它。
- 中间那块：`S.dirs` 和图片一起铺，文件夹卡片排在前面、只在筛选「全部」时出现
  （「未标注/已标注/有候选」说的是图片，掺文件夹容易误点）。
- `/api/dirs` 和 `/api/list` 都过滤 `HIDDEN_DIR`（`$` 开头、`.` 开头、`System Volume Information`），
  回收站点进去只有「没有权限」。

**配置写盘要合并，不然翻文件夹会卡**
`persistConfig()` 每次都要起一次进程走 DPAPI，单次几百毫秒。`apiList` 每次都会更新
`lastDir`，所以改成 `schedulePersist()` 延迟 1.2 秒合并写 —— 列目录从 500 ms 降到 60 ms（热缓存 8 ms）。

**改名只基于原始名（`origName`）**
首次写入时把当前文件名记进 XMP 的 `xmpMM:PreservedFileName`（PNG 记 `OriginalName` iTXt），
以后一律拿它重新拼，而不是拿当前文件名 —— 否则「标一次加一层」，改三次就是
`物种名_物种名_物种名_原名`。`buildName(base, labels, order)` 还会把上一轮的旧物种名一起剥掉，
所以改错重标也不会留残渣（`before.title` / `before.keywords` 从图片里读）。
撞名时 `uniquePath()` 加 ` (2)`，绝不覆盖；Windows 的大小写不敏感也用 `resolve().toLowerCase()` 兜了。

**跳聚合台怎么实现的**
tagden 只负责探测 + 拼 URL：`GET /api/hub/link` 打聚合台的 `/api/status`，确认它活着且
`app.openLocalImage === true`，然后返回
`http://127.0.0.1:8791/?img=<绝对路径>&group=<类群>&sites=<当前开着的站点>`
（`sites` 只在聚合台 `app.openLocalSites === true` 时带，老版本自动退化成只带类群）。

**一图一页的问题**：以前每点一次 `window.open(url, '_blank')` 就是一个新标签页，连点十张
就是十个聚合台。现在第一次开带固定名字的标签页（`HUB_TARGET = 'bioidhub'`，浏览器遇到同名
窗口会复用），之后用 `window.postMessage({type:'bioidhub:open-image', path, group, sites})`
把图直接递给那一页 —— 聚合台 `ingestLocalImage()` 追加进队列，不刷新、不清空。
只有收到 ack（`bioidhub:ack`，1.6 秒超时）才算送到；对面是 1.0.44 之前没这个监听，
就退回 `window.open(url, HUB_TARGET)` 那条老路 —— 目标名还在，仍然不会叠标签页。

端口不写死：并行探 `8791` / `8899` / `8792`，每个 800ms 超时，命中缓存 10 秒；
`--hub <port>` 给了就只探那一个（调试时别被同时开着的源码版串了）。

找不到人时**不能只报错**：`503` 的响应体里带 `code: 'HUB_DOWN'`、`tried: [端口]` 和
`download: {version, size, url}`（由服务端去读聚合台的 `latest.json` 换出 exe 绝对直链，
读不到就是 `null`），前端据此弹一张能照着做的卡片；版本太旧是 `409` + `code: 'HUB_OLD'`。
这条**只用在本机装没装聚合台**这件事上，识别流程一行都不依赖它。

聚合台那边新增 `GET /api/localfile?path=` 把文件字节吐出来（只认图片扩展名），
前端 `openFromUrl()` 取回 blob → `new File()` → 走原来的 `addFiles()` 入队识别，
并把参数从地址栏 `replaceState` 抹掉，刷新不会重复入队。

`sites` 是「精确清单」：标注工坊开着哪几个模型，聚合台就只开哪几个 —— 不自动补
`AUTO_KEEP`（iNaturalist 这类常备模型），清单里默认关着的（豆包）也照开。
聚合台收到后先按自己的硬规则压一遍（`pickPerVendor` 去同站、`groupConflict` 去跨类群），
`applySitesParam()` 直接覆盖 `state.selected` 而不走 `selectSite()`（后者会按「一网站一模型」
再顶掉一遍）。清单全无效时返回 `null`，退回 `applyGroupParam()` 的老行为。

**列表不整读文件**
`readLabelFast()` 只读头 128KB（段被截断才补读到 1MB）+ PNG 的尾 256KB。
注意「列表接口本身」已经不调用它了 —— 上千张的文件夹改成 `labelcache` + `/api/labels` 后台补，
理由见上面那节。

**识别方案**
`PRESETS` 里每档给两组站点：`sources`（本类群该问的，默认全开）和 `optional`（能问但默认关，
目前只有豆包 —— 大模型自由发挥、结论发散且按次计费）。`siteReady()` 再过滤掉没配账号的。

数组顺序就是界面上开关的顺序：本门类 → 「多识动物 / 百度动物」兜底 → 通用站（iNaturalist）。

用户的开关按方案存在 `config.ui.picks[preset]`（`POST /api/config {picks: [...]}`），
`presetSources()` 优先用它、否则用默认名单，所以切走再切回来还记得。
`/api/state` 的 `current.available` 会把每个站摊开成 `{key, on, ready}` 给前端画开关。

多识/懂鸟/晓虫在一个厂商下按类群拆成多个站点，批量场景下允许同时开（一张图可能是虫也可能是植物）。

**安全**
只监听 127.0.0.1，且校验 `Host` 头必须是 localhost/127.0.0.1（挡 DNS rebinding）。
没有任何鉴权 + 能读写任意路径，**不要绑到 0.0.0.0**——要局域网用必须先加口令。

## 测试

```
node .probe/t-exif.js        # 扫本机照片，看哪些真有 EXIF 缩略图/坐标
node .probe/t-speed.js       # 缩略图 vs 原图的体积与耗时对比
node .probe/t-decode.js      # 浏览器里禁用缓存对比「加载+解码」总耗时
node .probe/test-meta.js     # 18 项：XMP/PNG 写入往返、重复写、改值、结构完好
node .probe/test-rename.js   # 21 项：6 种命名格式、不叠加、撞名、非法字符、CSV
node .probe/test-origname.js # 16 项：原始文件名往返、PNG、老 CSV 迁移
node .probe/test-report.js   # 31 项：归档（预览/执行）+ 两张 CSV（用带 GPS 的真照片）
node .probe/ui-tagden.js     # 20 项：端到端（需要服务已启动）
node .probe/ui-tree.js       # 24 项：文件夹树（盘符/展开折叠/点名字进入/中间文件夹卡片/地址栏定位/上一级）
node .probe/ui-rename.js     # 17 项：重命名选项 + 跳聚合台（两个服务都要开着）
node .probe/ui-hub.js        #  7 项：聚合台 ?img= 自动载入并识别
node .probe/ui-perf.js       # 11 项：2671 张的真实文件夹（首屏/铺满/点击/占位徽标），PERF_PORT=7801
node .probe/ui-hub-group.js  #  7 项：跳过去时类群真的切成昆虫（两个服务都要开着）
node .probe/ui-v2.js         # 20 项：缩略图 / 面板 EXIF / 归档开关 / 导出 / 批量归档
node .probe/ui-chips.js      # 21 项：模型开关（名单是否列全 / 豆包默认关 / 点击开关 / 按方案记忆 / 顶栏不溢出）
node .probe/ui-hub-sites.js  # 15 项：跳过去时按 ?sites= 精确开模型（不补常备 / 同站去重 / 清单无效回退）
node .probe/ui-hub-send.js   # 10 项：连点两次只留一个聚合台标签页，第二张进同一队列（要 1.0.44+ 聚合台）
node .probe/ui-hub-down.js   # 11/9 项：没装聚合台、聚合台太旧时的两张引导卡片（APP= 7812/7813，见文件头）
```

合计 228 项。`ui-perf` 别和别的 UI 测试连着跑（要独占 Chrome 调试端口），单独跑。

测试会清空并重放 `testpics/`，所以别往那个目录放自己的照片。

`.probe/shots/` 里是自动截的图。

## 改 start.bat 时必须遵守的两条

1. **编码 GBK（cp936），不是 UTF-8**。cmd.exe 按控制台代码页（中文 Windows 是 936）读批处理，
   UTF-8 的中文会被读成 `'爣娉ㄥ伐鍧?姝ｅ湪鍚姩鈥?' 不是内部或外部命令`——乱码被当命令执行。
2. **换行 CRLF，不是 LF**。用 LF 时 cmd 会把相邻行粘一起，`chcp >nul` 会吞掉下一行，
   `cd /d "%~dp0"` 也就没生效，于是 `node server.js` 跑在 `C:\Windows\System32` 下，报 `MODULE_NOT_FOUND`。

改完这样自查：

```bash
python -c "d=open('start.bat','rb').read(); print('CRLF', b'\r\n' in d, '| 裸LF', d.replace(b'\r\n',b'').count(b'\n')); d.decode('gbk'); print('GBK ok')"
```

另外不要在 bat 里用 `chcp 65001` 配合 UTF-8 注释——那是另一个坑；Node 自己在 TTY 下走
`WriteConsoleW`，中文照常显示，不需要改代码页。`timeout /t` 也别用，某些环境里会被解析成别的程序。

