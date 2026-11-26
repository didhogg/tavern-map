# 图层地图 0.5.8 · 周围地点的来源资料与 Wiki

> 日期：2026-11-26  
> 范围：补齐“图层地图 · 周围地点”的 AI 字段开关。

## 新增设置

在扩展设置 → 图层地图 · 周围地点新增：

- **附带来源资料**：把附近地点详情里的来源资料文本（可编辑保存的全局文本）放进 AI 上下文；
- **附带 Wiki 正文**：把附近地点已经缓存的 Wiki / 来源链接正文放进 AI 上下文。

两个选项默认关闭，避免一次把最多 50 个附近地点的长文本全部塞进 prompt；需要时打开即可。

## 输出格式

附近地点条目本身仍是一行，来源资料和 Wiki 正文作为缩进子行：

```text
Nearby (nearest 8, within radius):
- Yawning Portal (WDH 地点) — <0.01% · S
  Source material: 类型：WDHLocation 区域：Castle Ward
- Empty Keg (酒馆) — <0.01% · E
  Source material: 类型：Tavern 区域：Castle Ward
```

当前地点仍保持：

```text
Current place: ...
Current place note: ...
Current place source: ...
Current place wiki (...): ...
Nearby (...)
```

## 设置实时生效

新增和已有图层 AI 开关都通过 `data-layer-setting` 统一读写；`LayerMapUI.handleSettingsChanged()` 与 `refreshContext()` 会重新读取实时设置，因此勾选/取消后 AI 预览立即变化。

## 验证

- 打开“附带来源资料”后，附近 8 个地点的 `Source material` 出现在 `Nearby` 条目下；
- 关闭后立即消失；
- 当前地点来源资料仍紧跟在 `Current place` 后面；
- `npm run check`、`npm run build` 通过。
