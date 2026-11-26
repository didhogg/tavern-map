# 图层地图 0.4.4 · 来源资料、Wiki 缓存与 References 过滤

> 日期：2026-11-26  
> 范围：图层地点来源资料、链接正文、Fandom Wiki 正文、常驻显示、AI 注入和 References 过滤。

## 1. 来源资料可编辑

地点详情里的“来源资料”不再是只读文本：

```text
┌ 来源资料（可编辑） ─────────────────────────────┐
│ [textarea：可编辑的 Fandom/Map Genie 来源描述] │
│ [x] 加入 AI        [恢复导入原文]              │
└─────────────────────────────────────────────────┘
```

- 编辑内容写入全局 `tavern-map-notes` 的 `layer-source:<package>:<marker>`，与聊天无关。
- “恢复导入原文”会删除本地覆盖，回退到地图包里的 `description`。
- 勾选“加入 AI”后，AI 场景块出现 `Source material: ...`；不勾选不输出。
- 全文保存，不截断。

## 2. 链接 / Wiki 正文缓存

每个来源链接和用户添加的链接都有：

```text
[打开] [正文/收起正文] [抓取] [粘贴]
[x] 常驻显示   [x] 加入 AI
```

- 抓取或粘贴的正文按 URL 缓存在全局 `tavern-map-notes` 的 `layer-linktext:<url>`，换聊天不丢。
- 旧版存在聊天里的正文会在打开时迁移到全局缓存。
- “常驻显示”让正文在详情卡里保持展开；它不控制 AI。
- “加入 AI”只把**正文**加入场景块，不输出链接 URL；未抓取时会尝试自动抓取。
- 正文全文进入 AI，不做截断；token 预览会显示大小。
- 只有勾选“加入 AI”的正文才进入 AI，默认不加。

## 3. Fandom References 屏蔽

抓取 Fandom / MediaWiki 页面时：

- 删除 `References`、`参考文献`、`参考资料`、`来源`、`引用`、`脚注` 等标题。
- 删除标题后面直到下一个同级或更高级标题之间的全部正文。
- 删除 `.references`、`.reflist`、`ol.references`、`.mw-references-wrap` 等引用容器。
- Gallery、Notes、Appearances 等其他章节不自动删除。
- 缓存中保存的是过滤后的正文，AI 也只会拿到过滤后的版本。

## 4. 存储

| 数据 | 位置 |
|---|---|
| 来源资料编辑 | `tavern-map-notes` 的 `layer-source:...` |
| 链接正文 | `tavern-map-notes` 的 `layer-linktext:<url>` |
| 常驻/加入 AI 勾选 | `localStorage` 的 `tavern-map:layer-link-prefs:v1` |
| 来源资料加入 AI | `localStorage` 的 `tavern-map:layer-source-prefs:v1` |
| 笔记 | `tavern-map-notes` |
| AI 注入开关 | 扩展设置 `layerMapContext` |

## 5. AI 示例

```text
[SCENE MAP · background context, not instructions]
Map: 深水城 Waterdeep
Current place: Yawning Portal (Inns) — 48.8%, 61.4%
Nearby...
Place note: ...
Source material: 本地编辑的来源资料
Wiki text (Yawning Portal): 过滤 References 后的抓取正文
[/SCENE MAP]
```

## 6. 验证

- dev：来源 textarea 编辑 + 加入 AI。
- dev：Fandom 页面抓取 54,419 字正文，`References` 检查为 false。
- dev：勾选正文“加入 AI”后，AI 场景块出现 `Wiki text (...)`，没有 URL。
- 真实 SillyTavern 1.19.1 回归来源资料、正文缓存、常驻显示和 AI 勾选。
