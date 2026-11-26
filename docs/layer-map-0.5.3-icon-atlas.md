# 图层地图 0.5.3 · GTA6 原始图标 atlas

> 日期：2026-11-26  
> 范围：Map Genie icon-set 雪碧图导入与绘制。

## 发现

GTA6 / Leonida 的 Map Genie 页面没有使用 icon font，而是使用：

```text
https://media.mapgenie.io/v2/assets/prod/games/grand-theft-auto-6/
  icon-set/build/v158/atlas.png
  icon-set/build/v158/atlas.json
```

`atlas.json` 的 key 形如 `g.atms.a`，与 `mapdata.categories[].icon` 对应。该资源允许 CORS，因此可以在导入时下载。

## 实现

1. 从瓦片路径推断游戏 slug；
2. 尝试读取 icon-set atlas JSON/PNG；
3. 解析 frame 矩形和 pixelRatio；
4. 只保留分类图标可用的 frame；
5. 将 atlas PNG 作为 Blob 存入地图包；
6. 绘制时按分类色画圆底，再从 atlas 裁出 18×18 原始图标；
7. 没有 atlas 时回退 icon font；再没有就使用彩色圆点。

GTA6 当前使用 `v158`。如果上游更新版本导致 404/403，会安全回退，不会阻断地图导入。Cyberpunk 2077 继续使用公开的 icon font；RDR2 也可使用 font/sprite。

## 显示与性能

- 低缩放仍使用 36px 网格数量簇，避免数千个图标每帧绘制；
- 放大到逐点层级后显示原始 atlas 图标；
- 原始图标按分类缓存为 Canvas；
- 刷新后从 IndexedDB 读取 atlas Blob，不需要重新下载。

## 注意

- 0.5.2 及之前已经导入的 Leonida 包没有 `iconAtlas`；请重新导入同一个包一次。
- 重新导入会保留笔记、底图、网格、聊天和收藏。
- 如果 Map Genie 更换 atlas 版本，当前固定 `v158` 会回退为彩色圆点；后续可改为从页面配置读取版本。
