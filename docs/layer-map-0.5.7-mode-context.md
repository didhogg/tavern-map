# 图层地图 0.5.7 · 关闭后恢复模式与 AI 上下文顺序

> 日期：2026-11-26  
> 范围：记住最后使用的现实/图层地图模式；保留图层地图的包、视角和选中内容；修复 AI 上下文的当前地点笔记/来源资料顺序。

## 模式恢复

`MapState` 新增 `lastMapMode`，随聊天写入 `chatMetadata['tavern-map']`：

- 在图层地图里点顶部 `×`：记录 `layer`；
- 在现实地图里点 `×`：记录 `real`；
- 之后再点右下角地图按钮：打开上一次使用的模式，而不是默认现实地图；
- 页面刷新、切回聊天后仍恢复；
- 图层地图关闭时不销毁 `LayerMapUI`，包 id、镜头中心/缩放、“我”的位置、当前地点、详情和分类隐藏状态都继续保留。

现实地图仍使用原来的每个聊天状态；图层地图仍按地图包保存位置和视角。

## 底图切换

- 给地图包加载增加代次 token；快速切换包时，旧包的异步初始化不会覆盖新包。
- 从图片地图切回瓦片地图、或关闭再打开时，`setTileMapVisible`、`applyTileSource`、恢复视角和 fit 后都会 `resize()` + `triggerRepaint()`，避免 MapLibre 容器重新显示后停在空白画布。

## AI 上下文

`buildLayerContext` 现在把当前地点的内容紧跟 `Current place` 输出：

```text
Current place: ...
Current place note: ...
Current place source: ...
Current place wiki (...): ...
Nearby (...):
...
Favorites:
...
```

此前当前地点笔记排在 Nearby 和 Favorites 后面，模型容易把 `Place note` 误认成附近地点的笔记。现在使用明确的 `Current place note` / `Current place source` 标签，并放在所有周围地点和收藏模块之前。

## 设置实时生效

`LayerMapUI.handleSettingsChanged()` 和 `refreshContext()` 会重新读取 `SillyTavern` 的实时上下文；在扩展设置里切换“来源资料进入 AI / 笔记进入 AI”等选项后，AI 预览和实际注入立即更新，不再使用旧 settings 快照。

## 验证

- 图层地图按 `×` → 重新点地图按钮：回到图层地图，Tych 包、Z13.3 视角、当前位置和详情仍在；
- 页面刷新后仍回到上次模式；
- 切到现实地图，关闭后重新打开：回到现实地图；
- Tych ↔ 深水城图片包来回切换：瓦片底图重新出现；
- AI 预览顺序：Current place → Current place note → Current place source → Nearby → Favorites；
- 来源资料复选框关闭时不输出，重新打开后立即恢复；
- `npm run check`、`npm run build` 通过。
