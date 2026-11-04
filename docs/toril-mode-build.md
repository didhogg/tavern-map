# Toril 适配模式构建文档

> 日期：2026-11-04  
> 状态：**草案，未实现**。当前仓库仍是 `0.3.10` 的现实世界地图版本。  
> 适用范围：`/Users/xxx/tavern-map` 独立测试扩展，单用户、非商业测试。  
> 数据源：`/Users/xxx/DND- reference（DO NO DELETE！）`，**只读，不修改、不删除、不移动**。  
> 依据：官方 Toril GIS `2026-11-01_2` 快照、Toril Explorer PMTiles、DND5e_chm、5etools-cn、Huiji DND Wiki。

---

## 0. 一页结论

Toril 适配是一个**独立地图 provider**，不是把现实世界的 OSM 数据换一套样式。

```text
现有 OSM 模式                         新增 Toril 模式
──────────────                       ──────────────
真实地球经纬度                         Toril 自定义椭球
Photon / Overpass / OSRM              本地 GIS 数据，无外部地理 API
Wikipedia GeoSearch                   FR Wiki 固定链接
3D/地形能力（现有模式保留）           2D 平面，无 DEM、无山体阴影、无 3D 建筑
```

第一版做成：

```text
2D 平面地图
  + 2,847 个地点（有名字的优先显示）
  + 61 个命名区域
  + 331 条主路 / 水下隧道
  + 地点详情、区域路径、笔记、收藏
  + FR Wiki
  + 英文地名 + 中文副名
  + 手动路线 / 椭球距离 / D&D 旅行时间
  + 主要道路图寻路（标明“只覆盖主路”）
```

不做：

- 完整 Google 式逐街导航；
- 3D 地形、山体阴影、DEM、3D 建筑；
- Toril 上的公交/驾车/实时路况；
- 把 Huiji 或 FR Wiki 的全文直接混进英文地名库；
- 把 Toril 坐标发给 OSM、Google、Photon、OSRM、Transitous。

---

## 1. 目标与非目标

### 1.1 目标

1. 在设置里增加 **地图模式：现实世界 / 托瑞尔（2D）**。
2. Toril 模式完全本地化：不请求 OpenFreeMap、Photon、Overpass、OSRM、Transitous。
3. 数据内置到测试扩展里，默认只在本机构建产物中出现，不提交原始数据到公开仓库。
4. 地图为 **2D 俯视平面**，默认不倾斜、不旋转、无地形起伏。
5. 地图地名**永远以英文为主行**；有已确认中文时，在英文下面显示一行中文。
6. 中文名优先从本地 DND5e_chm、5etools-cn 和 Huiji 批量导入，不依赖运行时在线翻译。
7. 保留现有地点卡、收藏、笔记、Wiki、AI 场景块、路线 UI 的交互习惯。
8. 路线的能力边界必须写清楚，不能把“主路估算”伪装成完整导航。

### 1.2 非目标

- 不替换或重写现有 OSM 模式。
- 不把 Toril 数据写进 `SavedPlace` 的现实世界状态；两套状态分开。
- 不承诺所有地点都有中文名、简介或 Wiki。
- 不承诺任意两地都能沿道路自动连通。
- 不把 Huiji 的页面全文导入本插件；第一版只取“地点名 + 来源链接/版本”。
- 不在公开仓库分发 Toril GIS 原始数据包；单用户测试版可本地内置。

---

## 2. 数据源与实测事实

### 2.1 本地数据源

所有路径均按原样使用，构建脚本只读：

```text
/Users/xxx/DND- reference（DO NO DELETE！）/
├─ Toril GIS/
│  ├─ toril-gis-2026-11-01_2/
│  │  ├─ toril_gis_layers.gpkg       ← 属性 + location_paths 优先
│  │  ├─ toril_gis.qgs
│  │  └─ README.md
│  ├─ toril-gis-geojson/layers/      ← 几何 + 简单浏览
│  ├─ toril-gis-shapefiles/
│  ├─ dem_v3.tif                     ← 第一版不使用
│  └─ toril_gis_layers.gpkg          ← 快照副本
│
├─ DND5e_chm-main/
│  ├─ 剑湾冒险者指南/欢迎来到国度/托瑞尔诸地.html
│  ├─ 被遗忘的国度/...
│  └─ ...
│
└─ 5etools-cn-main/
   └─ data/...
```

> 构建脚本要先枚举文件，不要只依赖单个文件名；不同资料包的文件名/编码可能不同（DND5e_chm 的 HTML 常见 GBK/GB18030 编码）。

### 2.2 实际规模

已检查的 `2026-11-01_2` 快照：

| 类别 | 数量 | 说明 |
|---|---:|---|
| 地表居民点 | 1,397 | City / Town / Village |
| 地表重要地点 | 647 | 堡垒、遗迹、神庙等 |
| 地表自然地标 | 716 | 其中只有 96 个有名字 |
| 地表命名区域 | 61 | Polygon |
| 地表主路 | 326 | Primary Road |
| 水下隧道 | 5 | Underwater Tunnel |
| 地表河流 | 1,195 | 只有 2 条有名字 |
| 地表地点合计 | 2,760 | 1,397 + 647 + 716 |
| Underdark 地点 | 87 | 50 + 20 + 17 |
| 全部地点合计 | 2,847 | 含 Underdark |
| 有英文名 | 2,210 | 不是 2,847 个全部可标名 |
| 有英文简介 | 1,256 | 约 44% |
| 有 FR Wiki 链接 | 1,173 | 约 41% |
| 有 location_paths | 2,847 | 需要从 GPKG 读 |

### 2.3 关键数据事实

1. **GPKG 有 `location_paths`，GeoJSON 没有。**  
   GeoJSON 只导出 `location_en` / `location_ru` / `location_it` 的扁平字符串；GPKG 里是完整 JSON 数组。地点树必须用 GPKG 的属性，或者把 GeoJSON 的 `location_en` 按 `→` 临时拆开。

2. **几何坐标使用 FRIA 经线。**  
   `geog_extent` 同时保存 `md` 和 `fria` 两套经度；实际 GeoJSON `geometry.coordinates` 与 `fria` 一致。

3. **MD 与 FRIA 的经度差基本恒定。**  
   对 2,821 条点/区域记录交叉检查，MD - FRIA 落在 `53.4811°` 到 `53.4817°` 之间，工程上可先取 `53.4815°`。这是一个强假设，不是宇宙法则；上线前用已知地点回归。

4. **道路数量远少于“完整路网”。**  
   326 条 Primary Road + 5 条 Underwater Tunnel，合计 331 条；只有 7 条有名字。  
   按道路端点做连通性检查，约 100 个连通分量，最大分量 46 条路、约 20,106 km。  
   也就是说：**可以画主路、可以做主路图，但不能承诺任意两地沿路可达。**

5. **Explorer 的 PMTiles 没有隐藏的第二套路网。**  
   检查 `toril-vector-surface.pmtiles` 的 `srf_civ_pathways_ln` 后，类别仍只有 Primary Road 与 Underwater Tunnel；样式里虽然定义了 Secondary Road，数据里没有。  
   互动地图上“看起来很多路”，主要是这 326 条主路被切成很多段绘制。

6. **Underdark 是独立数据面。**  
   当前 `udk_nat_tunnels_ln` 是 0 条；不要把它当成已经可用的地下路网。Underdark 先做平面图层/地点，不做 3D 垂直堆叠。

---

## 3. 用户可见行为

### 3.1 模式切换

```text
设置
└─ 地图模式
   ├─ 现实世界（现有 OSM）
   └─ 托瑞尔（2D，本地数据）
```

切换行为：

- 切换模式时，不覆盖原 OSM 模式的收藏、笔记、当前地点和视角。
- Toril 使用自己的状态命名空间，例如 `state.toril`。
- 两种模式的 FAB、面板、详情卡布局可以共用，但数据源和路由按钮文案要区分。
- Toril 模式不显示“公共交通”“驾车”等现实世界路线方式。

### 3.2 平面界面示意

```text
┌──────────────────────────────────────────────┐
│ [模式：托瑞尔 2D]  [搜索地点……]      [图层]  │
├──────────────────────────────────────────────┤
│                                              │
│        ╭──────────── 2D 平面 ────────────╮   │
│        │                                  │   │
│        │        Waterdeep                 │   │
│        │        深水城                    │   │
│        │          ●                       │   │
│        │                                  │   │
│        │   Faerûn > Sword Coast           │   │
│        │                                  │   │
│        ╰──────────────────────────────────╯   │
│                                              │
├──────────────────────────────────────────────┤
│ 地点卡：Waterdeep / 深水城                   │
│ 区域：Faerûn > Sword Coast > Waterdeep       │
│ 类型：City   [收藏] [笔记] [路线] [Wiki]     │
└──────────────────────────────────────────────┘
```

### 3.3 地名显示规则

**硬规则：**

1. 地图标签的主行永远是英文 `name_en`。
2. 只有存在**已确认中文名**时，才在英文下面增加一行中文 `name_zh`。
3. 中文不能替代英文；不能出现只有中文的标签。
4. 没有中文时，只显示英文；不显示空的第二行。
5. 中文名只显示一个 canonical 值；别名放在详情卡和搜索结果里，不在地图上堆多行。
6. 点、搜索结果、地点卡、AI 场景块都采用“英文在上/中文在下”的顺序。
7. 没有英文名的自然点不强行标中文；第一版不标注未命名要素。

示例：

```text
地图标签                 搜索结果                地点卡标题
────────                 ────────                ──────────
Waterdeep                Waterdeep               Waterdeep
深水城                   深水城                  深水城
```

---

## 4. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│ SillyTavern UI / 现有面板外壳                               │
│  收藏 · 笔记 · AI 预览 · 设置 · 地图容器                     │
└──────────────────────────────┬─────────────────────────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
        ┌────────▼────────┐         ┌────────▼────────────┐
        │ OSM Provider    │         │ Toril Provider      │
        │ 现有逻辑         │         │ 新增，完全独立       │
        └────────┬────────┘         └────────┬────────────┘
                 │                           │
   Photon/Overpass/OSRM             本地 JSON/GeoJSON
   Wikipedia GeoSearch               FR Wiki 固定 URL
                 │                           │
                 └─────────────┬─────────────┘
                               │
                     ┌─────────▼─────────┐
                     │ 共用 UI 文件        │
                     │ 详情卡 · 收藏 · 笔记 │
                     │ AI 场景块 · 预览    │
                     └───────────────────┘
```

### 4.1 Provider 边界

```text
src/
├─ providers/
│  ├─ osm/                现有现实世界逻辑，先不重构
│  └─ toril/
│     ├─ index.ts         provider 入口、能力声明
│     ├─ data.ts          加载本地点/区域/道路
│     ├─ coords.ts        FRIA/MD、Toril 椭球距离
│     ├─ names.ts         中文名匹配与显示
│     ├─ search.ts        本地搜索/附近
│     ├─ region.ts        地点树、区域判断
│     ├─ wiki.ts          FR Wiki 读取与清理
│     ├─ route.ts         手动/主路/旅行时间
│     └─ context.ts       Toril 场景块
├─ toril/                 构建产物（本地生成，谨慎提交）
└─ ui.ts                  共用外壳，按 provider 切换
```

### 4.2 状态隔离

建议不要直接复用现有 `MapState` 的坐标语义。可以这样分层：

```text
chatMetadata['tavern-map']
├─ version
├─ provider: 'osm' | 'toril'
├─ osm: { ...现有状态... }
└─ toril: {
     view: { centerFria, zoom },
     currentPlaceUuid,
     selectedPlaceUuid,
     savedPlaceUuids,
     placeNotes: { [uuid]: string },
     route: {...},
     lastTab
   }
```

原则：

- 收藏/笔记用 `uuid` 作为键，不用显示名。
- 中文名只是显示字段，不能当主键。
- 切换回 OSM 时不丢 Toril 状态；反之亦然。
- 不把 Toril 的经度写进 OSM 的 `MapState.center`。

---

## 5. 数据构建流水线

### 5.1 只读原则

```text
DND- reference（只读）
        │
        │  构建脚本只读，绝不写入、移动、删除
        ▼
┌─────────────────────────────┐
│ scripts/toril-build-data    │
│ 读取 GPKG + GeoJSON + 翻译库 │
└──────────────┬──────────────┘
               │
               ▼
toril-build/ 或 public/toril/   ← 插件能直接 fetch 的本地资产
               │
               ▼
          dist/toril/             ← 仅本机测试安装时复制
```

### 5.2 几何与属性怎么合并

推荐：

```text
GeoJSON layer ── geometry + uuid
        │
        ├── 用 uuid join
        │
GPKG core.*_v ── location_paths + descr + url + source + geog_extent
        │
        ▼
规范化 JSON / GeoJSON
```

理由：

- GeoJSON 的几何最好读，MapLibre 也直接吃 GeoJSON。
- GPKG 有完整的 `location_paths` 和属性，但浏览器不宜直接解析 40MB SQLite。
- 构建时用 `uuid` 把两边拼起来，避免在浏览器里做 GIS。

如果本机有 GDAL，也可以用 `ogr2ogr` 直接把 GPKG 转 GeoJSON；但这会引入工具依赖。第一版优先用“GeoJSON 几何 + GPKG 属性”的轻量方案。

### 5.3 图层取舍

| 图层 | 数量 | 第一版 | 处理 |
|---|---:|---|---|
| `srf_civ_populated_places_pt` | 1,397 | 必选 | 全部导入；无名也保留点，但只标有名 |
| `srf_civ_important_sites_pt` | 647 | 必选 | 全部导入 |
| `srf_nat_landmarks_pt` | 716 | 必选 | 全部导入；只有 96 个有名字 |
| `srf_con_named_regions_pg` | 61 | 必选 | 简化后导入 |
| `srf_civ_pathways_ln` | 331 | 必选 | 路线图 + 可选显示 |
| `srf_nat_rivers_ln` | 1,195 | 可选 | 低优先级；不要默认全显示 |
| `srf_nat_land_pg` | 2,022 | 必选 | 简化后作陆地底图 |
| `srf_nat_ocean_pg` | 16 | 必选 | 简化后作海洋底图 |
| `srf_nat_lakes_pg` | 150 | 必选 | 简化后作湖泊 |
| `srf_nat_sea_ice_pg` | 2 | 可选 | 简化后可保留 |
| `srf_nat_lake_islands_pg` | 52 | 可选 | 第一版可合并到陆地 |
| `srf_nat_land_cover_pg` | 479 | 第一版不做 | 体积换视觉，性能优先 |
| `srf_nat_land_regions_pg` | 482 | 第一版不做 | 有 61 个命名区域就够了 |
| `srf_nat_climate_pg` | 2,968 | 不做 | 52MB，直接排除 |
| `glb_con_graticule_*` | 1,083 | 不做 | 经纬网不是跑团必需 |
| `glb_con_time_zones_pg` | 26 | 不做 | 第一版不需要 |
| `coastlines_pg` | 2,052 | 可选 | 与陆地/海洋重叠；不重复加载 |
| `srf_nat_marine_regions_pg` | 1 | 不做 | 可并入海洋 |
| `srf_nat_linear_landmarks_ln` | 5 | 不做 | 数量太少 |
| `srf_civ_structures_ln` | 0 | 不做 | 当前为空 |
| `srf_civ_buildings_pg` | 0 | 不做 | 当前为空，且 3D 明确不做 |
| `udk_civ_populated_places_pt` | 50 | 必选 | Underdark 平层 |
| `udk_civ_important_sites_pt` | 20 | 必选 | Underdark 平层 |
| `udk_nat_landmarks_pt` | 17 | 必选 | Underdark 平层 |
| `udk_con_named_regions_pg` | 2 | 必选 | Underdark 平层 |
| `udk_nat_domains_pg` | 15 | 可选 | 地下领域面 |
| `udk_nat_landforms_pg` | 12 | 可选 | 地下地貌面 |
| `udk_nat_lakes_pg` | 17 | 可选 | 地下湖泊 |
| `udk_nat_tunnels_ln` | 0 | 不做 | 当前为空；留接口，不做假路网 |
| `udk_nat_underground_cover_pg` | 1 | 不做 | 数量太少 |

### 5.4 输出文件

```text
toril-build/
├─ toril.manifest.json       快照号、生成时间、源文件哈希、许可提示
├─ places.json               2,847 个地点的规范化记录
├─ regions.geojson           61 个命名区域（简化）
├─ base.geojson              陆地/海洋/湖泊的平面底图（简化）
├─ roads.geojson             331 条主路/水下隧道
├─ rivers.geojson            可选
├─ underdark.geojson         地下地点/区域/可选面
├─ route-graph.json          道路节点/边（延迟加载）
├─ names.zh.json             英文 → 中文名/来源/置信度
└─ labels.json               地图标签用的轻量索引（可选）
```

第一版可以直接 fetch GeoJSON/JSON，不急着上 PMTiles。  
如果后面地图卡顿，再把 `base`、`roads` 转成 PMTiles 或矢量瓦片；不要一开始引入额外复杂度。

### 5.5 规范化记录

```text
TorilPlace
  uuid              GPKG/GeoJSON 的稳定 id
  layerId           来源图层
  featureClass      City / Town / Ruins / Fortification / ...
  featureRank       用于标签优先级
  nameEn            必有才显示标签
  nameZh            可空；来自 names.zh.json
  nameAliasesEn[]   搜索别名
  locationPaths[]   GPKG 的 location_paths
  regionLabel       "Faerûn > Chult > Jungles of Chult"
  descrEn           可空
  urlEn             可空，通常是 FR Wiki
  lonFria / lat     几何坐标，内部统一
  sourceSnapshot    "2026-11-01_2"
```

```text
TorilRegion
  uuid, nameEn, nameZh, layerId, geometry,
  descrEn, urlEn, locationPaths[]
```

```text
TorilRoad
  uuid, featureClass, nameEn?, geometry,
  lengthKm, isUnderwater, sourceSnapshot
```

```text
TorilNameRecord
  uuid?, nameEn, nameZh, aliasesZh[], source,
  sourceUrl, revisionId, confidence, reviewed,
  license, updatedAt
```

### 5.6 数据校验

构建脚本必须在写产物前检查：

```text
[ ] 地点数量 = 2,847
[ ] 地表地点 = 2,760
[ ] Underdark 地点 = 87
[ ] 区域 = 61
[ ] 道路 = 331（326 Primary + 5 Underwater）
[ ] 每个地点 uuid 唯一
[ ] GeoJSON 的 uuid 能 join 到 GPKG 属性
[ ] location_paths 全部能解析为 JSON 数组
[ ] name_en 为空的记录不进入标签层
[ ] 所有坐标落在 Toril 数据范围内
[ ] 道路长度字段与几何长度不出现数量级错误
```

---

## 6. 中文名与 Huiji 批量导入

### 6.1 显示规则

```text
nameEn = "Waterdeep"
nameZh = "深水城"

地图：        Waterdeep
              深水城

搜索结果：    Waterdeep
              深水城
              城市 · Faerûn > Sword Coast

地点卡：      Waterdeep
              深水城
```

- `nameZh` 只来自已确认记录。
- AI 建议、模糊匹配、未审核结果不能直接显示为“中文名”。
- 一个地点只有一个 canonical 中文；别名收在详情卡/AI，不在地图上堆叠。
- 没有中文时，地图保持英文单行，不显示占位符。

### 6.2 中文名来源优先级

```text
1. 人工确认（最高）
2. DND5e_chm 双语原文（既有中文译本的译名）
3. Huiji DND Wiki 页面标题/重定向（覆盖最广，需审核）
4. 5etools-cn 术语（类型/规则词；地名覆盖不一定全）
5. AI 候选（只进待审核队列，不直接显示）
6. 无中文 → 英文单行
```

发生冲突时：

- 不删除其他候选；
- 记录 `alternatives`、`source`、`confidence`；
- 地图只取 `reviewed=true` 的最高优先级值；
- 详情卡可以显示“其他译名”。

本地优先提取样本（只读）：

```text
DND5e_chm-main/剑湾冒险者指南/欢迎来到国度/托瑞尔诸地.html
DND5e_chm-main/被遗忘的国度/费伦英雄/第二章/剑湾.htm
DND5e_chm-main/被遗忘的国度/费伦英雄/第四章/第四章：奥罗拉的诸国度目录.htm
DND5e_chm-main/被遗忘的国度/费伦冒险/第一章/第一章：运作国度.htm
DND5e_chm-main/被遗忘的国度/费伦英雄/第二章/第二章：诸国度指南.htm
```

提取方式：

- 先按文件实际编码解码（DND5e_chm 常见 GBK/GB18030）；
- 优先找“中文名\nEnglish”或“中文名English”的双语并列行；
- 不用整段中文正文做地名，避免把普通名词当专名；
- 与 Toril GIS 的英文名做精确/别名匹配；
- 产出候选后人工抽查，不直接覆盖 Huiji 候选。

### 6.3 Huiji 导入流程

Huiji 的 DND 站点：

```text
https://dnd.huijiwiki.com/
```

页面底部声明：

- 站点文本/大部分图片与英语数据取自 5e tools 的部分使用 MIT；
- 中文译文来自 5e 不全书或社区，5e 不全书部分使用 GPL3；
- 其他内容通常为 **CC BY-NC-SA 4.0**；
- 站点条款和具体页面可能另有说明，导入前逐项确认。

导入流水线：

```text
2,210 个有英文名的 Toril 地点
          │
          ▼
标准化英文名 + 别名
          │
          ▼
Huiji 搜索 / 重定向 / 精确标题
          │
          ├─ 精确命中 → 候选中文标题
          ├─ 重定向命中 → 候选 + 低一级置信度
          ├─ 多个候选 → 按类型/区域去歧义
          └─ 无命中 → 不伪造中文
          │
          ▼
人工抽查 / 冲突处理
          │
          ▼
names.zh.json
```

匹配时不要只搜英文。更稳的顺序是：

```text
DND5e_chm 先给出候选中文
        │
        ├─ 用中文去 Huiji 找页面
        │     └─ 页面标题/分类/首段中的名称核对英文名
        │           （只读取匹配所需的名称信息，不保存全文）
        │
        └─ 没有中文候选的英文名
              └─ 再用英文搜 Huiji
```

**访问方式必须先定，不要假设 API 一定能脚本直连。**  
实测 `https://dnd.huijiwiki.com/api.php` 当前会被 Cloudflare challenge 拦下并返回 403。构建文档的要求是：

- 优先使用站方允许的导出/API/数据包；
- 如果只能浏览器访问，由用户在本机浏览器中手动导出或授权使用；
- 不写绕过 Cloudflare / 反爬的脚本；
- 请求加正常 User-Agent，低频、缓存、可中断；
- 不抓全站 39K 页面，只查询 Toril 的 2,210 个有英文名的地点。

建议的 MediaWiki 查询（在站方允许的前提下）：

```text
api.php?action=query&list=search&srsearch=<name>&srlimit=10&format=json
api.php?action=query&titles=<candidate>&redirects=1&prop=info&format=json
```

只取：

- 页面标题；
- canonical URL；
- revision id；
- 必要的分类/消歧信息；
- 首段中用于核对英文名的短句（只作为匹配证据，不保存全文）。

**不保存/不再分发全文、不取图片、不把 Huiji 正文塞进 AI 上下文。**

### 6.4 匹配规则

```text
normalize(name):
  Unicode NFKC
  小写
  弯引号 → 直引号
  去除首尾空白
  合并连续空格
  可选：去掉 (city) / (town) / (location) 这类消歧后缀
```

匹配顺序：

1. 英文名精确匹配；
2. 重定向后的标题匹配；
3. `name_alt_en_str` 别名匹配；
4. 去掉消歧后缀后匹配；
5. 类型 + 区域辅助去歧义；
6. 模糊候选只进入待审核，不直接写入 canonical。

建议置信度：

| 情况 | confidence | 是否直接显示 |
|---|---:|---|
| 人工确认 | 1.00 | 是 |
| DND5e_chm 双语明确对应 | 0.95 | 是 |
| Huiji 精确标题 | 0.90 | 是，抽检后 |
| Huiji 重定向 | 0.80 | 需抽检 |
| 别名匹配 | 0.75 | 需审核 |
| 模糊搜索 | 0.40 | 否 |
| AI 翻译 | 0.20 | 否，仅候选 |

显示门槛建议：`reviewed=true` 且 `confidence >= 0.80`。  
第一版宁可少显示中文，也不要给玩家错误地名。

### 6.5 `names.zh.json` 记录格式

```json
{
  "schema": "toril-names/v1",
  "snapshot": "2026-11-01_2",
  "records": [
    {
      "uuid": "019b7c17-c8a0-41a6-8395-092329ba3997",
      "nameEn": "Dungrunglung",
      "nameZh": "敦格伦伦",
      "aliasesZh": [],
      "source": "huiji",
      "sourceUrl": "https://dnd.huijiwiki.com/wiki/...",
      "revisionId": 123456,
      "confidence": 0.9,
      "reviewed": true,
      "license": "CC BY-NC-SA 4.0",
      "updatedAt": "2026-11-04"
    }
  ]
}
```

> 上例的中文只是格式示例，不代表已核实译名。实际值必须来自导入/人工审核。

### 6.6 中文名的验收标准

```text
[ ] 对 2,210 个有英文名的地点跑完匹配
[ ] 输出 matched / ambiguous / unmatched 报表
[ ] 人工抽查至少 100 条
[ ] 抽查准确率 >= 95%
[ ] 所有地图显示的中文都 reviewed=true
[ ] 没有中文-only 标签
[ ] 没有把 AI 候选写成已确认译名
```

如果 Huiji 访问或授权暂时解决不了，不阻塞主流程：  
先用 DND5e_chm + 人工表，Huiji 作为后续增量导入。

---

## 7. 2D 地图与标签

### 7.1 投影与相机

第一版使用 **MapLibre 的平面 Mercator 兼容视图**：

```text
projection: mercator（不使用 globe / vertical-perspective）
renderWorldCopies: false
maxPitch: 0
dragRotate: false
touchPitch: false
bearing: 0
```

说明：

- Toril 是自定义椭球，但 MapLibre 的屏幕投影只负责“把经纬度摆到平面”；距离和面积不交给 MapLibre。
- 所有实际距离用 `coords.ts` 的 Toril 椭球计算。
- 不加载 DEM，不做地形起伏；`dem_v3.tif` 第一版不进入产物。
- 不启用 `raster-dem`、`hillshade`、`terrain`、`fill-extrusion`、`sky`。
- 地图只允许平移和缩放；不提供倾斜/旋转按钮。

### 7.2 图层顺序

```text
1. 背景海洋（纯色）
2. 陆地 / 海岸线（简化面）
3. 湖泊 / 海冰（可选）
4. 命名区域（低透明度填充 + 细边界）
5. 河流（可选、低对比）
6. 主路（细线；路线规划时高亮）
7. 地点点（分类色；低 zoom 聚合）
8. 双行地名（英文主行，中文副名）
9. 当前地点 / 人物标记
10. 路线几何 + 起终点
```

Underdark 是单独的平面图层组，不是把地表压到地下 3D：

```text
地表图层组  ←→  Underdark 图层组
  同一张 2D 画布，不同配色/不同数据
```

### 7.3 双行标签

首选**一个 symbol layer + 格式化文本**，让英文和中文成为同一个标签、同一个碰撞单位：

```text
layer: place-label
  filter: has nameEn
  text-field:
    ["format",
      ["get", "nameEn"], {"font-scale": 1.0},
      ["case", ["has", "nameZh"], "\n", ""], {},
      ["case", ["has", "nameZh"], ["get", "nameZh"], ""], {"font-scale": 0.78}
    ]
  text-size: 12
  text-color: #eee
  symbol-sort-key: featureRank
```

大白话：

- 英文是第一行，任何情况下都不会被中文替换；
- 有 `nameZh` 才追加第二行；
- 中文没有时不会出现空行；
- 英文和中文一起参与碰撞，不会出现“英文被挤掉、只剩中文”的标签；
- 中文可以用更小字号，但仍是同一标签。

只有在真机验证过“英文/中文不会单独出现”时，才允许退化成两个独立 symbol layer；否则不要用两个独立图层。

字体/字形注意：

- MapLibre 的 `glyphs` 必须能提供中文和拉丁字形。
- 第一版可以用本地字体子集或现有可用的 glyph 服务；不要把完整 CJK 字体硬塞进 `index.js`。
- 如果没有可靠 glyph 源，退化为 HTML marker 只渲染当前视口内的地名；不要直接显示方框/豆腐字。
- 标点、撇号、长地名要跑真实数据测试。

### 7.4 性能策略

```text
- 只加载点/区域/道路/简化底图，不加载 climate、land cover、DEM、3D。
- 低 zoom 聚合地点点；高 zoom 才展开。
- 只给有 name_en 的点加标签。
- 区域只保留 61 个命名区域，不用 482 个 land regions。
- 底图多边形做简化；目标总数据 < 10MB 未压缩。
- 中文副名只对可见标签生效。
- 路线图/河流延迟加载，不阻塞首屏。
- 滚动/缩放时不触发外部网络请求。
```

### 7.5 不做 3D 的验收

代码/运行时检查：

```text
[ ] 没有 raster-dem / hillshade / terrain 图层
[ ] 没有 fill-extrusion
[ ] 没有 sky / globe / vertical-perspective
[ ] map.getMaxPitch() === 0
[ ] 拖动不会改变 bearing/pitch
[ ] dist 中没有 dem_v3.tif
[ ] 没有 3D 建筑或地形起伏
```

---

## 8. POI、搜索、详情

### 8.1 本地 POI

Toril 模式不查询 Overpass/OSM：

```text
places.json
   │
   ├─ 空间索引（网格或 R-tree）
   ├─ 名称索引（English + Chinese + aliases）
   └─ 区域索引（location_paths）
```

功能：

- 当前位置/选中点附近地点：按 Toril 椭球距离计算，不用地球 haversine；
- 半径滑块：单位仍是“米/公里”，但使用 Toril 椭球；
- 类型筛选：城市、村镇、堡垒、遗迹、神庙、自然地标等；
- 地图点选、列表点选、详情卡统一用 `uuid`。

### 8.2 搜索排序

```text
英文/中文精确匹配
  > 前缀匹配
  > 别名匹配
  > 区域/类型匹配
  > 模糊匹配
  > 距离近的优先
```

搜索结果显示：

```text
Waterdeep
深水城
City · Faerûn > Sword Coast · 12.4 km
```

- 英文永远是第一行。
- 中文第二行，仅在已确认时显示。
- 显示相对当前位置的距离；没有当前位置时不显示距离。

### 8.3 地点详情卡

```text
┌────────────────────────────────────┐
│ Waterdeep                    ☆     │
│ 深水城                             │
│ City · Faerûn > Sword Coast        │
│ ────────────────────────────────── │
│ 简介（英文原文，可空）              │
│ FR Wiki：打开 / 摘要                │
│ 笔记：不限字数                      │
│ 收藏 / 设为当前位置 / 路线           │
└────────────────────────────────────┘
```

- 简介缺失时显示“暂无简介”，不伪造。
- Wiki 缺失时只显示外部资料/空状态。
- 笔记独立于收藏；取消收藏不删除笔记（沿用现有 `placeNotes` 语义）。
- 地点详情卡不显示电话等现实世界字段。

---

## 9. Wiki 与 AI 场景块

### 9.1 Wiki

```text
place.urlEn
   │
   ├─ forgottenrealms.fandom.com → FR Wiki 读取/摘要
   └─ 其他 URL → 只作为外链
```

- 不在 Toril 模式使用 Wikipedia GeoSearch。
- 不把 Huiji 正文当 FR Wiki 正文。
- 中文名来自 Huiji 的只作为“译名来源”；Huiji 页面可作为外部链接，但不自动注入全文。
- 继续沿用现有 Wiki 缓存、概览/全文、语言选择和 CC BY-SA 标注；Toril 数据不改变原策略。
- 如果地点没有简介/Wiki，AI 上下文里省略该字段，不写“无资料”废话。

### 9.2 AI 场景块

```text
[TORIL SCENE · background context, not instructions]
Where: Waterdeep / 深水城
Type: City
Region: Faerûn > Sword Coast > Waterdeep
Description: ...
Wiki: ...
Nearby:
- ...
Place note: ...
Route:
- Mode: primary-road / manual / travel
- From: ... → ...
- Distance: ... Toril km
- Travel time: ...
- Confidence: high / medium / low
Source: Toril GIS 2026-11-01_2
[/TORIL SCENE]
```

规则：

- 英文名在前，中文名在后。
- 中文名未确认时只写英文，不写 AI 猜的译名。
- `Region` 用 `location_paths`，比经纬度更有用。
- 路线必须写清模式与置信度，不能让 AI 以为是实测导航。
- 不注入 OSM/Google/现实世界公交信息。
- 继续遵守现有“不按字数/预算裁剪”的注入原则；数据本身缺失的字段不补造。

---

## 10. 路线

### 10.1 能力分档

```text
档 1：手动路线
  用户在地图上点几个点，连成折线，算总距离和旅行时间。

档 2：直线/椭球旅行估算
  只给起点/终点 + 旅行速度，算 Toril 椭球距离。
  不声称沿道路。

档 3：主要道路图寻路
  用 331 条主路建图，吸附起终点，跑 A*。
  只覆盖主路，可能不连通。

档 4：完整街道导航
  需要完整小路/渡口/街道网络。
  当前数据不够，不做。
```

第一版做 1、2、3 中的“可用部分”，第 4 档明确不做。

### 10.2 Toril 椭球

```text
a  = 6,410,000 m
rf = 160.25
f  = 1 / rf
b  = a * (1 - f)
```

要求：

- 距离用 Toril 椭球，不用地球 haversine。
- 手动折线的每一段都用同一套距离函数。
- 道路长度优先使用数据里的 `geog_extent` 预计算值；没有则用几何计算。
- 坐标内部统一为 FRIA；显示层需要 MD 时再做转换。
- 不把经纬度差值直接当米。

### 10.3 主要道路图

```text
roads.geojson
   │
   ▼
按交叉点/端点打断
   │
   ▼
节点 + 边（记录 roadUuid / 长度 / 类别 / 名字）
   │
   ├─ 起点吸附最近主路
   ├─ 终点吸附最近主路
   ▼
A* / Dijkstra
   │
   ▼
路线 + 距离 + 置信度
```

注意：

- 当前 331 条线、约 100 个端点连通分量；最大分量 46 条路、约 20,106 km。
- 只有 7 条道路有名字；大多数步骤只能写“主路（未命名）”。
- 没有小路、渡口、完整街道。
- 不连通时不要硬画一条假路线；显示“无法仅用主路连通”，并提供手动路线/直线估算。
- Underdark 当前没有隧道数据（0 条），不要做假地下图。

### 10.4 路线 UI

```text
路线
├─ 手动路线（点地图添加拐点）
├─ 仅椭球估算（起点 → 终点）
├─ 主要道路（自动；标注“主路估算”）
└─ 旅行时间（步行/坐骑/船只/手动速度）
```

- Toril 模式不显示“公共交通”。
- 不显示现实世界 OSRM/Transitous 失败提示。
- 路线摘要必须带：

```text
模式：主要道路（估算）
范围：仅主路，可能不完整
置信度：中 / 低
```

- 路线 POI 用本地点空间索引按走廊筛选，不再请求 Overpass。

---

## 11. 内置数据与构建

### 11.1 单用户测试构建

用户已经明确这是单人测试插件，所以第一版允许把**生成后的精简数据**放进本地构建产物：

```text
toril-build/          ← 构建脚本生成，建议 gitignore
dist/toril/           ← 本地安装用，公开仓库不要提交
```

建议：

```text
.gitignore
  toril-build/
  dist/toril/
```

如果仓库是公开的，不要提交：

- Toril GIS 原始 GPKG；
- 完整 GeoJSON 包；
- Huiji 抓取正文；
- 大体量生成数据。

只提交代码、构建脚本和许可说明。  
需要 GitHub 安装时，使用私有构建产物/本地目录安装；公开仓库安装不应依赖这些数据。

### 11.2 构建命令（计划）

```bash
export TORIL_REFERENCE_ROOT="/Users/xxx/DND- reference（DO NO DELETE！）"

npm run toril:data     # 只读参考目录，生成 toril-build/
npm run toril:names    # 单独执行中文名导入/审核，不自动运行
npm run check
npm run build          # 把 Toril 资产复制到 dist/toril/
```

`toril:data` 的要求：

- 路径不存在时直接报错；
- 不写参考目录；
- 输出带 `snapshot` 和 hash 的 manifest；
- 先写临时目录，校验通过后再替换；
- 失败不产生半成品。

### 11.3 数据体积目标

```text
places.json        2–3 MB
regions.geojson    1–2 MB（简化）
base.geojson       2–4 MB（简化）
roads.geojson      1.5–2 MB
rivers.geojson     可选
underdark          0.2–0.5 MB
names.zh.json      0.2–0.5 MB
manifest           < 20 KB
─────────────────────────
目标总计           < 10 MB 未压缩
```

不把 30MB GeoJSON 全包、不把 40MB GPKG 放进浏览器、不加载 4MB DEM、不加载 52MB climate。

### 11.4 许可与署名

| 来源 | 许可/状态 | 第一版处理 |
|---|---|---|
| Toril GIS | README 标注 WotC Fan Content Policy；GPKG 元数据另有 CC BY-SA 条目 | 单人本地测试；公开/分发前确认；保留来源与免责声明 |
| Toril Explorer / PMTiles | 站方数据，WotC Fan Content 语境 | 不直接再分发 PMTiles；只用于核对 |
| Huiji DND Wiki | 站点声明 CC BY-NC-SA 4.0；部分译文 GPL3/MIT | 只导入译名/URL/版本；署名；非商业 |
| DND5e_chm | GPL3 | 只提取译名/术语；保留来源与许可 |
| 5etools-cn 中文数据 | CC BY-NC-SA 4.0；代码 MIT | 只作术语/候选；署名；非商业 |
| FR Wiki | CC BY-SA 4.0 | 运行时读取；署名；避免长段逐字复述 |
| 5e tools 英文数据 | MIT（按站点声明） | 如使用，保留 MIT 声明 |

落地时必须更新：

```text
NOTICE.md
- Toril GIS / WotC Fan Content 声明
- Huiji / DND5e_chm / 5etools-cn / FR Wiki 署名
- 数据快照号与修改说明
```

> 以上是工程记录，不是法律意见。公开分发前应重新确认每个来源的条款。

---

## 12. 里程碑

| 阶段 | 交付物 | 验收 |
|---|---|---|
| P0 数据审计 | 本地点/区域/道路/翻译源清单 | 数量、字段、UUID join、许可记录完成 |
| P1 数据构建 | `toril-build/` + manifest | 2,847 / 61 / 331 校验通过；不修改参考目录 |
| P2 Provider + 2D 地图 | `toril` 模式、平面底图 | 切换后不请求 OSM；`maxPitch=0`；无 3D |
| P3 地点/区域/标签 | 点、区域、双行标签、详情卡 | 英文主行；中文副名；无名不标；点击可用 |
| P4 中文名 | `names.zh.json` + 导入报表 | 2,210 个名字跑完；抽查准确率 ≥95% |
| P5 搜索/笔记/收藏/AI | 本地搜索、详情、场景块 | 中英文搜索；笔记持久；AI 英文在前 |
| P6 手动/旅行路线 | 折线、椭球距离、旅行时间 | 与预计算长度误差可解释 |
| P7 主路图 | A*、置信度、失败提示 | 连通时能走；不连通不伪造 |
| P8 性能/回归 | 体积、首屏、ST 实机 | 数据 <10MB；OSM 模式不受影响 |

第一版范围建议：**P0–P6 + P8**。  
P7 作为“可选增强”，不阻塞地点/Wiki/AI 的主体价值。

---

## 13. 测试计划

### 13.1 数据

```text
[ ] places = 2,847
[ ] surface = 2,760
[ ] underdark = 87
[ ] regions = 61
[ ] roads = 331
[ ] named places = 2,210
[ ] location_paths parse 成功率 = 100%
[ ] GeoJSON/GPKG UUID join 无丢失
```

### 13.2 地图

```text
[ ] 进入 Toril 模式后无 OpenFreeMap/Photon/Overpass/OSRM/Transitous 请求
[ ] 地图无 pitch/bearing 操作
[ ] 无 DEM/terrain/hillshade/fill-extrusion 请求
[ ] 底图是平面色块，不是 3D 地形
[ ] 缩放/拖动/聚合正常
[ ] 中文缺字时不是豆腐块
```

### 13.3 地名

```text
[ ] Waterdeep 显示 Waterdeep + 深水城
[ ] 无中文地点只显示英文
[ ] 没有中文-only 标签
[ ] 搜索中文能命中，结果英文在前
[ ] 地点卡英文标题 + 中文副标题
[ ] AI 场景块英文在前
```

### 13.4 数据/内容

```text
[ ] 简介为空的地点显示空状态
[ ] FR Wiki 链接能打开/摘要
[ ] 取消收藏后笔记仍在
[ ] 收藏/笔记按 uuid 持久化
[ ] 区域路径来自 location_paths，不是猜的
```

### 13.5 路线

```text
[ ] 手动折线距离与 Toril 椭球计算一致
[ ] 主路 A* 只在连通分量内给出路线
[ ] 不连通时显示明确失败/手动回退
[ ] 无名道路不伪造街名
[ ] 路线不进 OSRM/Transitous
```

### 13.6 性能

```text
[ ] 数据首屏加载可接受（桌面单用户测试）
[ ] 低 zoom 不渲染 2,847 个独立标签
[ ] 大面积多边形已简化
[ ] 切换回 OSM 模式无 Toril 状态污染
[ ] `npm run check` / `npm run build` 通过
```

---

## 14. 风险与未决

| 风险 | 影响 | 处理 |
|---|---|---|
| 道路只有主路 | 不能完整导航 | 只做“主路估算”，不连通时明示 |
| 多数道路无名 | 无法逐街指令 | 显示“主路/未命名道路”，不编造 |
| 中文匹配歧义 | 错误译名 | 置信度 + 人工审核；未审核不显示 |
| Huiji Cloudflare/条款 | 批量导入可能受阻 | 不绕过；用授权导出/人工；不阻塞主流程 |
| MapLibre 中文字形 | 标签豆腐块 | 本地字体子集或视口内 HTML 标签 |
| Toril 投影/椭球 | 距离或位置错 | 内部统一 FRIA；距离用自定义椭球；已知点回归 |
| 数据内置 | 仓库/许可风险 | 本地测试构建；公开仓库不放数据 |
| 数据体积 | 首屏慢 | 简化、裁剪、延迟加载；不上 DEM/climate |
| GPKG 浏览器不可读 | 运行时复杂 | 构建时转 JSON/GeoJSON，不在浏览器读 GPKG |
| FR Wiki 缺失 | 资料不全 | 空状态 + 简介；不伪造 |

### 待确认

1. Huiji 的批量访问方式：站方 API、导出包、人工导出，还是只能逐页浏览器操作？
2. Huiji 的中文地名覆盖率；先跑 2,210 个英文名，拿报表再决定是否扩大。
3. MapLibre 中文字形方案：本地子集 vs 现有 glyph 服务。
4. Toril Explorer 深链的 `longitude` 到底用 MD 还是 FRIA；只有做 URL 同步时才需要。
5. 是否把生成数据提交到公开仓库；默认 **不提交**。
6. 主路图是否值得在 v1 做；如果连通性太差，先只做手动/直线路线。
7. `udk_nat_tunnels_ln` 后续是否会有数据；当前 0 条，不做地下自动路线。

---

## 15. 参考

- Toril GIS 文档：`https://www.geospatial-grimoire.com/worlds/toril/gis/docs/`
- Toril GIS 数据模型：`https://www.geospatial-grimoire.com/worlds/toril/gis/docs/data-model-overview/`
- Toril Explorer：`https://www.geospatial-grimoire.com/worlds/toril/explorer/`
- Huiji DND Wiki：`https://dnd.huijiwiki.com/`
- FR Wiki：`https://forgottenrealms.fandom.com/`
- 本地 DND5e_chm：`/Users/xxx/DND- reference（DO NO DELETE！）/DND5e_chm-main`
- 本地 5etools-cn：`/Users/xxx/DND- reference（DO NO DELETE！）/5etools-cn-main`
- 本地 Toril GIS：`/Users/xxx/DND- reference（DO NO DELETE！）/Toril GIS`

---

## 16. 实施顺序建议（最短闭环）

```text
1. 只做本地数据构建 + 2D 底图
2. 加 2,847 个点 + 61 个区域 + 英文标签
3. 加中文副名（先人工/5e，Huiji 后补）
4. 加搜索、详情、笔记、收藏
5. 加 FR Wiki + AI 场景块
6. 加手动路线/椭球距离
7. 最后再评估主路 A*
```

这样即使 Huiji 暂时不能批量导入、主路图不连通，地点/区域/Wiki/AI 的核心跑团价值也已经可用。
