# 图层地图 0.5.4 · 地图视角持久化

> 日期：2026-11-26  
> 范围：按地图包保存“我”的位置和镜头视角。

## 问题

0.5.1 已经按地图包保存“我”的位置，但切换地图包时仍把 `state.view` 清空：

```text
Waterdeep 放大到 2.10×  → 切到 Leonida（10.1×） → 切回 Waterdeep
结果：Waterdeep 变成 Leonida 的 10.1×
```

瓦片地图还有一个延迟事件问题：切回图片地图后，旧 MapLibre 地图的 `moveend` 仍会触发，把 `this.view` 从图片地图的 2.10× 改成旧瓦片的 10.1×。

## 修复

- `LayerChatState` 新增 `viewsByPackage`：每个地图包保存 `{ cx, cy, zoom }`。
- `rememberUserPosition` 同时保存当前镜头视角。
- `restoreUserPosition` 同时恢复镜头视角和“我”的位置。
- `persist` 前取消旧定时器，避免切换期间旧保存覆盖新地图。
- 瓦片地图事件增加 `tileViewPackageId === pkg.id` 检查；旧瓦片地图的 `move` / `moveend` 不再影响新地图。
- `loadTileMap` 不再因为“包变了”强制 fit，只要该包有合法保存视角就恢复。
- localStorage 兜底同时保存每个地图包的视角和位置。

## 验证

- Waterdeep 缩放到 2.10×；
- 切到 Leonida，缩放到 10.1×；
- 切回 Waterdeep：恢复 2.10× 和原来的“我”；
- 再切回 Leonida：恢复 10.1×；
- 关闭/刷新/重进后仍恢复上次视角。
