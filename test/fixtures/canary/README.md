# 站点 canary 固定素材

这些是 `tools/canary.js` 用的固定图片和尺寸副本；butterfly 来自项目自带的 `testpics/`，plant 来自 Unsplash：

- `butterfly*`：来自 `testpics/蝴蝶_2.jpg`，2026-10-29 的标注记录把它定为
  `Endoclita sinensis`（中华蝠蛾）。canary 把它当「昆虫站点应该还能认出来」的提示，
  默认只要求请求成功；加 `--strict` 才要求这些站点 Top5 命中该学名。
- `plant*`：一张真实植物照片（橡皮树，Unsplash，photo-1501004318641-b39e6451bec6，Unsplash License），
  只用于确认植物站点不报错，没有强制物种断言。
- `.small.jpg` 是 ≤640 px 的副本（多识要求），`.jpeg` 是站点通用的 JPEG 副本。

素材不参与 exe 打包；只在 canary / 测试时读取。
