# 图层地图 0.5.1 · 正圆、位置持久化、区域名称与原始图标

> 日期：2026-11-26  
> 范围：0.5.0 的位置/半径/图标修正，以及 Map Genie 区域名和分类图标。

## 1. 半径圈

- 图层地图不再用归一化 x/y 画椭圆。
- 现在以“我”的屏幕位置为圆心，按地图宽度比例画正圆。
- 附近列表和 AI 的 Nearby 使用同一个屏幕圆判定，圈内/圈外与肉眼一致。
- 半径仍是地图宽度百分比；有网格时显示“几格”。

## 2. “我”的位置标记

- 图层地图和现实地图统一为小型红色水滴标记，约 30×40 px。
- 水滴尖端指向真实坐标，不再是大号圆形“我”图章。
- 仍然可拖动；图层地图可吸附地点，`Alt/⌥` 可自由放置。
- 工具栏只保留 `◎ 回到我`。

## 3. 位置持久化

- 每次移动“我”、调整半径、吸附地点都会保存。
- `LayerChatState.positionsByPackage` 按地图包保存：
  - 水城的位置不会因为切到 Leonida 再切回来而丢失；
  - 关闭图层窗口、刷新页面、重新打开仍恢复；
  - 每个聊天有自己的一套地图包位置。
- 同时写入 localStorage 兜底；真实 ST 的临时聊天/刷新后即使 chat metadata 暂时为空，也能恢复最后位置。
- 清除位置会同时移除该地图包的保存记录。

## 4. 区域名称

- Map Genie 的 `regions[]` 之前已经导入为多边形，但没有画标题。
- 现在用每个区域最大多边形的质心绘制区域名，带描边保证在瓦片底图上可读。
- 受“区域”图层开关控制；缩放达到区域显示层级后出现。
- 选中区域仍用高亮颜色显示。

## 5. Map Genie 原始分类图标

Mapdata 里的分类带有 `icon` slug，例如：

```json
{ "icon": "atms", "color": "00ff55" }
```

导入时现在会：

1. 从瓦片路径或来源 URL 推断游戏 slug；
2. 尝试读取 `https://cdn.mapgenie.io/css/themes/icons/<game>-icons.css`；
3. 从 CSS 中解析 `.icon-<slug>:before { content: "\\eXXX" }`；
4. 下载 `icomoon.ttf`；
5. 把字体 Blob 和 glyph 映射存进地图包；
6. 地图上用分类色圆底 + 白色原创图标绘制；没有图标时回退彩色圆点。

资产通过公开 CDN 获取，`access-control-allow-origin: *`；失败、离线或没有公开图标页时不会阻断地图导入。

### 已知边界

- Cyberpunk 2077、RDR2 等公开 Map Genie 图标 font 可取得。
- GTA6 / Leonida 的 `grand-theft-auto-6-icons.css` 和 markers sprite 目前返回 404/403，因此这版回退彩色圆点；如果上游以后公开，同一套导入逻辑会自动使用。
- Fandom `markers` JSON 通常没有分类图标字段，继续使用彩色圆点。
- 0.5.0 已经导入的包需要重新导入同一个包一次，才会下载并写入新的 `iconFont`；重新导入会保留聊天、笔记、底图、网格和收藏。
- RDR2 还有一份 sprite（`media.mapgenie.io/.../markers.png` + `.json`）；这版优先用 icon font，sprite 可后续扩展为更精确的位图图标。

## 6. 验证

- 图层 Waterdeep：正圆半径、红色水滴、切换 Leonida 后切回位置恢复。
- 图层 Leonida：区域名称显示；无图标 font 时彩色圆点。
- 图层 Cyberpunk Night City：导入时下载 icon font，分类图标按原始 glyph 绘制。
- 真实 SillyTavern 1.19.1 与 dev；`npm run check`、`npm run build`。
