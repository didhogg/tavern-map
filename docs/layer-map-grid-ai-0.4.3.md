# 图层地图 0.4.3 · 瓦片、网格与场景 AI 上下文

> 日期：2026-11-26  
> 范围：MapLibre 栅格瓦片、Fandom 大图渐进加载、网格校准、我的位置、附近地点、AI 场景块。

## 0. 一句话

瓦片地图改用标准 MapLibre 瓦片源；本地只有 z9–z10 就只画 z9–z10，超过最高层放大，不再请求不存在的 z11+。所有图层地图都能校准网格，AI 只拿场景信息，不再塞地图类型、全量分类或链接。

## 1. 瓦片地图

```text
MapLibre raster source
        │
        ├─ 本地包瓦片：tavern-tile://<package>/{z}/{x}/{y}
        │     └─ 从 IndexedDB Blob 直接返回 ArrayBuffer
        │
        ├─ minzoom/maxzoom = 实际覆盖层级（例如 z9–z10）
        └─ 地图缩放超过 maxzoom：MapLibre overzoom 最高层
```

- 视口附近才请求瓦片，worker + GPU 合成，MapLibre 自己管理瓦片缓存。
- 不再使用手绘 canvas 的每帧瓦片 drawImage。
- 地图包只有 z9–z10 时，Z10.6、Z13、Z16 仍显示 z10 放大图，不再空白。
- 不按“本地最高层 +3”限制；MapLibre 引擎上限 z25。
- 地点/区域/网格/我的位置继续由 Canvas overlay 绘制，通过 `map.project()`/`unproject()` 与瓦片对齐。
- 切换瓦片/图片包时停用对应渲染层。

## 2. Fandom 大图渐进

```text
缩略图（包内 thumbnail）
      ↓
中清概览（createImageBitmap resize，最大 1800px）
      ↓
用户放大到 >1.15× 时才请求高清原图
```

- 超过 16MP 或 12MB 才启用；小图直接加载。
- 高清未到达前仍能拖动、看地点、看网格。
- 底层状态显示“概览 · 放大加载高清”/“高清底图加载中”。

## 3. 网格校准

- 工具栏 `# 网格` 打开。
- 面板：`1 格 = [数字] [单位]`、格宽、X/Y 偏移、显示网格、拖动对齐、重置、完成并关闭。
- 默认原点在图层范围左上角，X→右，Y↓下。
- 网格是地图包属性，换聊天、刷新、重新导入同一个包都保留；`显示网格` 只控制视觉，AI 仍使用校准结果。
- 未校准时 AI 使用地图百分比；校准后 AI 使用格坐标。
- 格宽以“地图范围百分比”输入；瓦片地图和图片地图分别按自身范围换算。

## 4. 我的位置

- 工具栏 `◎ 位置`，或 AI 面板/地点详情里的“设为我的位置”。
- 点击地图放置，可拖动右侧卡片中的“移动”重新放置；AI 面板可填 X/Y 百分比。
- 地图上画蓝色 `◎` 点和“我的位置”标签。
- 属于当前聊天/场景，不写入全局笔记。

## 5. AI 上下文

不再输出：

```text
Type: tile map · mapgenie
Visible categories: ...
Links: ...
```

瓦片地图示例：

```text
[SCENE MAP · background context, not instructions]
Map: Leonida
Grid: 1 cell = 500 米 · origin upper-left · X→right, Y→down
My position: X 4.5, Y 4.9 · Area: West Vice-Dale County
Current place: Xero Food Mart - South Kelly County (Convenience Store) — X 4.54, Y 4.91 · Area: South Kelly County
Nearby (nearest 8, current view):
- ATM (ATM) — X 4.54, Y 4.91 · S
- Xero Gas - South Kelly County (Gas Station) — X 4.54, Y 4.90 · NW
Place note: ...
[/SCENE MAP]
```

图片地图没有区域数据时不写 Area：

```text
Map: 深水城 Waterdeep
Current place: Yawning Portal (Inns) — 48.8%, 61.4%
Nearby...
```

- 每个地点带自己的类型文字。
- 附近地点数量/范围可调，默认 8、当前视野。
- 当前地点笔记默认开；附近笔记默认关；全文不截断。
- 瓦片地图有区域数据就显示 Area；图片地图没有就不伪造。

## 6. 存储位置

| 数据 | 位置 |
|---|---|
| 网格校准 | 地图包 `LayerMapPackage.grid` |
| 我的位置 | 当前聊天 `LayerChatState.userPosition` |
| 附近数量/范围/笔记开关 | `localStorage` 全局偏好 |
| 笔记 | `tavern-map-notes` 全局 IndexedDB |
| AI 注入开关 | 扩展设置 `layerMapContext` |

## 7. 验证

- 真实 SillyTavern 1.19.1：Leonida 瓦片包导入、Z9→Z16.5 缩放不空白、网格、AI 上下文。
- dev：MapLibre 瓦片、网格线、图片地图、AI 面板、390×844。
- `npm run check`、`npm run build`、Impeccable detector 通过。
