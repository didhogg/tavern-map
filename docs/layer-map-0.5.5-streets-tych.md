# 图层地图 0.5.5 · 街道名称与 Tych Maps 兼容

> 日期：2026-11-26  
> 范围：从 Tych Maps 的 Waterdeep 数据生成可导入的 Tavern Map 图层包，并在地图上绘制街道名和区域名。

## Tych Maps 结构

Tych Maps 的 Waterdeep 页面不是单一的图片或 Map Genie 包：

- 底图：Mapbox GL 样式 `tychmaps/cm98zf08e00e401r9gc7ag86r`，由多个栅格图层和一个矢量街道层组成。
- 地点：`/map-data/waterdeep/*.geojson`，包含酒馆、商店、住宅、公会、神殿、仓库、陵墓、城市地标和 WDH 地点。
- 区域：`Wards.geojson` 提供 8 个城区多边形，`Wards_pts.geojson` 提供城区名称标注点。
- 街道：`Streets.geojson` 提供 312 条 LineString（其中 309 条有名称），原始页面用 Mapbox 的 `symbol-placement: line` 绘制街道名。

因此不能直接使用现有的 Fandom / Map Genie 页面 URL 读取，也不能把 pt 文件当普通图片导入。

## Tavern Map 的兼容方式

生成的包：

```text
/Users/xxx/Downloads/TavernMap-Packages/TavernMap-Tych-Waterdeep.zip
```

包内包含：

- `manifest.json`：`tileUrl` 指向 Mapbox Static Tiles API 的在线栅格模板；
- `mapdata.json`：
  - 578 个地点，11 个分类，3 个分类组；
  - 8 个城区面 + 城区名称锚点；
  - 309 条有名称的街道线；
  - `worldBounds` 使用 Tych 官方地图范围，`defaultView` 保持原始城市中心的初始视角。

底图仍然通过 Mapbox Static Tiles API 在线加载；街道名和城区名不是烘焙进瓦片的，而是 Tavern Map 读取包内线/面数据后绘制：

- `streets` 是 0.5.5 新增的包字段，按 WebMercator 归一化坐标保存；
- 街道标签按 `Main / Major / Minor` 分级，在低缩放先显示主路，放大后逐步显示支路；
- 区域标签使用 `labelX / labelY` 的原始标注点，不再只依赖多边形质心；
- 标签参与现有 48px 网格碰撞检测，避免和地点标签、区域标签互相覆盖。

## 验证

已在 `dev.html` mock 环境和真实 SillyTavern 1.19.1 中导入并检查：

- 初始视角显示 Field / Sea / North / City of the Dead / Trades / Southern / Castle / Dock 城区名；
- 放大后显示 Bazaar Street、Waterdeep Way、The High Road、The Street of Silks 等街道名；
- 578 个地点、8 个区域、309 条街道进入包数据；
- 无 `pageerror`；Mapbox 瓦片 CORS 正常。

## 限制

- 底图需要联网；使用的是 Tych 页面公开的 Mapbox access token，token 轮换或 Static Tiles API 变动时需重新生成包。
- 街道名是 Tavern Map 自己绘制的，不会完全复刻 Mapbox 的排版、字体和沿线重复标注。
- Tych Maps 的底图、地点和街道数据版权属于 Tych Maps / Mapbox；该包仅供个人本地使用，不应公开再分发。
- 由于 `tychmaps.com` 不返回 CORS 头，浏览器内的扩展不能直接根据 Tych 页面 URL 在线导入；目前采用本地生成 ZIP 后导入的方式。
