# 代码视图折叠（JSON/YAML/HTML/XML）— 设计文档

> 目标：文件 Tab 代码视图（CodeMirror 6 只读）为支持折叠的语言启用代码折叠——gutter 折叠标记 + 行内折叠占位符 + 折叠快捷键。首批语言 JSON/YAML/HTML/XML（用户诉求），其余语言随需后补。

## 1. 问题

大型 `package-lock.json`、swagger/OpenAPI（JSON/YAML）、`pom.xml`/Android layout 等 XML、生成的 HTML 在代码视图里动辄数千行，浏览定位困难。CodeMirror 语言包（`@codemirror/lang-json/-yaml/-html/-xml`）**出厂即内建 `foldNodeProp` 折叠范围定义**（数组/对象、mapping/sequence/list、Element 标签对），但视图未装折叠扩展，折叠能力未暴露。

## 2. 设计

### 2.1 选型：CM 原生折叠，零新依赖

`@codemirror/language` 6.12.4 自带完整折叠件（`foldGutter` / `codeFolding` / `foldKeymap` / `foldCode` / `unfoldCode` / `foldAll` / `unfoldAll`）。**不引入** `@replit/codemirror-indent-unit-markers` 之类第三方折叠增强。

- `foldGutter()` **一揽子装配**：内部已含 `codeFolding()`（源码实证：foldGutter 返回 `[markers, gutter, codeFolding()]`）——**不得**再重复挂 `codeFolding()`，否则 `foldConfig` facet 出现两个默认配置值（combineConfig 合并无碍但属冗余装配）。
- 折叠范围完全来自语言包的 `foldNodeProp`：lang-json（`Object`/`Array` foldInside）、lang-yaml（`FlowMapping FlowSequence` foldInside + `Item Pair BlockLiteral` 行首至节点尾）、lang-html（`Element` 含嵌套，script/style 子树内嵌语言同样有 foldNodeProp）、lang-xml（`Element` OpenTag 尾→CloseTag 头）。**本项目不加自定义 foldService**——四语言覆盖已足。
- StreamLanguage（shell/toml 等）无折叠数据，`foldable()` 恒空 → gutter 无标记，行为自然降级（无破坏）。
- js/python/go/rust/cpp/sql/css/markdown 语言包同样自带 `foldNodeProp`，`foldable()` 天然生效——`foldableFor` 不做语言白名单，**任何有折叠范围的语言一律出标记**（含后续新增语言，零维护）。与「首批语言 JSON/YAML/HTML/XML」的诉求表述不冲突：首批=用户点名，其余=免费搭车。

### 2.2 装配（code-view.tsx）

`buildExtensions` 增补，**放在语言扩展之后、search 之前**：

```ts
...(lang ? [lang] : []),
foldGutter(),               // 折叠标记 + 行内占位符（自带 codeFolding）
keymap.of(foldKeymap),       // Ctrl-Shift-[ / ] 折叠/展开光标行；Ctrl-Alt-[ / ] 全文
search({ top: true }),
```

- **无语言文件（lang=null）也装配折叠**：StreamLanguage/纯文本无 foldable 范围，gutter 恒空、keymap 无动作——统一装配无副作用，换取装配表无分支。
- `foldKeymap` 全键挂载：`Ctrl-Shift-[`/`Ctrl-Shift-]` 折叠/展开**光标行**；`Ctrl-Alt-[`/`Ctrl-Alt-]` **全文**折叠/展开——两条绑定均无 mac 覆盖（CM 源码实证），mac 上生效的是字面 ⌃⌥[ / ⌃⌥]，快捷键清单按此展示。只读视图光标透明但点击仍可置位，「光标行」键实际可用，只是透明光标下难感知位置——非主路径，快捷键清单不单列。`Ctrl-Alt-[`/`]` 与全局分发（window keydown）无冲突：全局未绑定该组合，事件在 CM 内被 keymap 消费（`preventDefault`）后 `e.defaultPrevented` 守卫拦住全局分发。
- **点击折叠占位符展开**：`cm-foldPlaceholder` 是 `Decoration.replace` widget，点击回调内建（`unfoldEffect`）——只读不影响 widget 交互。
- gutter 点击折叠：`foldGutter` 内建 click 处理器（fold/unfoldEffect），无需自写。

### 2.3 视觉（app.css）

复用现有 token，全部走语义变量（tokens.css 唯一权威）：

- **行号 gutter 与折叠 gutter 合流**（`.cm-gutters` 单容器）：折叠标记随行号列渲染（`FoldMarker` gutter 混入 `cm-gutters`），无独立折叠列——宽度不增，与 VS Code「标记浮在行号右侧」近似。
- 现状 `​.cm-gutters { pointer-events: none }`（只读浏览行号不抢指针，de3b6da）**必须放行**：折叠标记是 gutter 内唯一可点元素，`pointer-events: none` 会废掉点击折叠。改为 gutter 整体可点——副作用是行号区域也接 pointer 事件，但除折叠标记外无任何行号交互处理器，多余点击被 CM gutter click 分发忽略（无折叠范围行 `foldable()` 返回 null 即无动作），行为无损。
- `.cm-foldGutter` 标记字形（2026-09-08 修订，原「不改字形」弃用——DESIGN.md 图标 lucide 单一体系禁 Unicode 字形充当图标，`⌄`/`›` 属禁用形，与 2026-08-29 全量清零一致补漏）：`foldGutter({ markerDOM })` 自定义标记 DOM——lucide `ChevronDown` 12px（可折叠）/`ChevronRight` 12px（已折叠），经 `renderToStaticMarkup` 模块级一次性序列化为 SVG 字符串、`span.innerHTML` 注入（markerDOM 随视口滚动高频重建，逐标记 createRoot 会泄漏 root；静态 SVG 无 root、无泄漏）。tooltip：markerDOM 拿不到 view 无法走 `state.phrase`，由 `buildExtensions` 按 locale 闭包传 `cmPhrasesZh["Fold line"]/["Unfold line"]`（en 用 CM 内建英文原文）。颜色令牌化 + hover 反馈不变（SVG stroke 走 `currentColor`）：

```css
/* 垂直居中须两层都去行盒：CM 给 gutterElement 写显式 style.height（GutterElement.update），
 * 外层 flex 把 span 钉在该高度几何中心；但 span 自身仍是 inline 容器，SVG 作为 inline
 * 替换元素按基线对齐会在行盒底部留 descender 空隙——只居中外层等于「span 居中而 SVG
 * 在 span 内偏上」，残留偏移随字体度量漂移，故 span 也设 flex */
.code-view-host .cm-foldGutter span { display: flex; align-items: center; color: var(--outline); cursor: pointer; }
.code-view-host .cm-foldGutter span:hover { color: var(--on-surface); }
.code-view-host .cm-foldGutter .cm-gutterElement { display: flex; align-items: center; }
```

- `.cm-foldPlaceholder`：覆盖 CM baseTheme（`#eee` 浅灰底——dark 主题下突兀），令牌化：

```css
.code-view-host .cm-foldPlaceholder {
  background: var(--surface-container-high);
  color: var(--on-surface-variant);
  border: 1px solid var(--outline-variant);
  border-radius: 4px;
  margin: 0 1px; padding: 0 4px; cursor: pointer;
}
```

CM baseTheme 经 `Prec.lowest` 插 head.firstChild，app.css 文档序靠后同特异性胜出（design-code-view §2.4 已言明的覆写途径）。

### 2.4 i18n / 快捷键清单

- 设置页「快捷键」清单收局部键惯例（design-keyboard-shortcuts §8）：「输入与视图」组新增一行「折叠/展开代码」`Ctrl+Alt+[` / `Ctrl+Alt+]`（mac ⌃⌥[ / ⌃⌥]，两条绑定均无 mac 覆盖、字面 Ctrl+Option 生效）——`scFoldCode`（zh「折叠/展开代码」/ en「Fold/unfold code」）。
- CM 内建短语（"Fold line"/"Unfold line"/"folded code"/"unfold"/"Folded lines"/"Unfolded lines"/"to"）随 `EditorState.phrases` zh 注入，与 search 面板短语同表（`searchPhrasesZh` → 更名 `cmPhrasesZh`）。

### 2.5 范围外（不做）

| 项 | 原因 |
|---|---|
| 折叠态跨 Tab 切换持久化 | 折叠态是 CM state field，重挂载重建（key 隔离）即丢——与 doc 同步（重拉整体替换）现状一致，浏览语义可接受；持久化需 foldEffect 序列化，成本高收益低 |
| markdown 源码态标题折叠 | lang-markdown foldNodeProp 按 fenced block 折叠，无标题折叠语义；标题导航已有 TOC（预览态） |
| 折叠全展开/全折叠工具条按钮 | `Ctrl+Alt+[`/`]` 键盘路径已覆盖；工具条按钮无用户诉求（Keep Lean） |
| 自定义折叠范围（indent 折叠等） | foldService 自定义是编辑器级功能，浏览优先级低 |

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/code-view.tsx` | `buildExtensions` 增 `foldGutter`/`foldKeymap`；phrases 表补折叠短语并更名 `cmPhrasesZh` |
| `src/renderer/src/styles/app.css` | `.cm-gutters` 放行 pointer；`.cm-foldGutter`/`.cm-foldPlaceholder` 令牌化 |
| `src/renderer/src/components/shortcuts.ts` | 输入与视图组 + `scFoldCode` 行 |
| `src/renderer/src/i18n/index.ts` | `scFoldCode` zh/en |
| `src/renderer/src/components/code-view.test.tsx` | 折叠装配冒烟（JSON gutter 标记、foldEffect/unfoldEffect 折叠展开还原、纯文本无标记） |
| `docs/design-code-view.md` | §2.3 装配更新；「不做的事」折叠行移除并引本文档 |

## 4. 验收

- 打开大 JSON/YAML/HTML/XML 文件：行号列折叠标记（lucide ChevronDown）出现，点击折叠→行内 `…` 占位符（令牌化样式）、点击占位符或标记展开（已折叠行标记为 ChevronRight）；
- `Ctrl+Alt+[` 全部折叠 / `Ctrl+Alt+]` 全部展开（JSON/YAML/HTML/XML 生效；sh/ts 等其他语言同样生效——foldNodeProp 出厂自带）；
- 无折叠范围语言（txt/unknown.xyz）无标记无键动作；
- 主题切换（dark/light）标记与占位符颜色正确；全局快捷键（Alt 系、Ctrl+B 等）不受影响；
- 折叠状态下重拉（doc 同步整体替换）后折叠范围失效但不报错（foldState 与新 doc 不匹配时 CM 内建丢弃无效折叠，属预期）；
- `npm run test` / `npm run typecheck` 全绿。