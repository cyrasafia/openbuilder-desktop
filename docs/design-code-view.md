# 代码浏览：行号 + 语法高亮（CodeMirror 6）— 设计文档

> 目标：文件 Tab 的文本文件视图从 `<pre>` 升级为只读 CodeMirror 6 视图——行号 + 按扩展名映射的语法高亮 + Ctrl+F 搜索；markdown 源码态同步升级。
>
> 选型依据（AGENTS.md「参考代码」）：`../openchamber` 是 React 19 + CodeMirror 6 的实证选型来源（FilesView 即 CM 只读视图）。本设计借鉴其 `languageByExtension.ts`（静态语言映射 + 特殊文件名兜底）与 class 化 HighlightStyle + CSS 变量主题的做法，但**不引入**其 shiki 双轨高亮与 vim 模式。
>
> openbuilder 移动端对照（design-file-view.md「代码/纯文本 Mode」）：用 highlight.js + 手写行号列 + 软换行默认开。桌面端不做逐行 ListView 手搓——CM 自带虚拟化/增量解析/搜索面板，覆盖同一诉求。

## 1. 问题

FileView 源码态是 `<pre className="file-content">`：无行号、无高亮、无搜索。代码文件的浏览（对齐 diff、看实现）在桌面端是高频诉求，纯文本体验差。

## 2. 设计

### 2.1 依赖与结构

新增 `@codemirror/{state,view,language,search,legacy-modes}` + 12 个 `lang-*` 包（js/json/python/go/rust/yaml/markdown/html/css/sql/cpp/xml）。**不引入**：

- `@codemirror/language-data`（全模式懒加载注册表）——静态映射足够，包体确定；
- `@uiw/react-codemirror` 之类封装——自写 ~70 行 React 生命周期壳（openchamber 同样自写）；
- `basicSetup`——它捆绑了编辑器向扩展（历史/补全/折叠），只读浏览不需要，按需手选。

新文件：

| 文件 | 职责 |
|---|---|
| `components/code-view.tsx` | React 壳：EditorView 生命周期、doc 同步、readonly 装配 |
| `components/cm-lang.ts` | `languageForPath(path): Extension \| null`——扩展名/特殊文件名 → LanguageSupport |
| `components/cm-theme.ts` | class 化 HighlightStyle（cm-keyword/cm-string…）+ 基础 theme spec |
| `styles/app.css` | `.cm-*` 颜色全部走 `--syntax-*` 语义令牌（tokens.css 唯一权威） |

### 2.2 语言映射（静态）

- js 家族：`ts/tsx/mts/cts/js/jsx/mjs/cjs`（lang-javascript 开关组合）
- json 家族：`json/jsonc/json5/jsonl/ndjson/geojson`（openbuilder 同款 `.jsonc/.jsonl → JSON`）
- `py/pyi/pyw` / `go` / `rs` / `yaml,yml` / `md,markdown,mdown,mkd` / `html,htm` / `css,scss,sass,less` / `sql` / `c,h,cpp,hpp,cc,cxx,hh` / `xml,svg`
- shell 家族（legacy-modes StreamLanguage）：`sh/bash/zsh/fish`、`toml`、`properties/ini/env`
- 特殊文件名：`Makefile/GNUmakefile` → shell（openchamber 同款兜底）、`Dockerfile` → dockerfile（legacy-modes）
- markdown 传入静态 `codeLanguages` 解析表（LanguageDescription name/alias 匹配围栏语言）——md 源码态围栏代码块内也有语法高亮
- 未命中 → null → 纯文本（无高亮，行号仍在）

### 2.3 只读视图行为

- `EditorState.create({ doc, extensions: [lineNumbers(), syntaxHighlighting(classHighlighter), languageForPath(path), search 搜索, EditorState.readOnly] })`
- **readonly + editable 并用**（editable 保持 true）：内容可聚焦——键盘滚动、Ctrl+F（searchKeymap，面板 top 汇报）可达；不可编辑。search 面板在 readonly 下自动隐藏 replace 控件（CM 内建）。面板短语按 locale 注入 `EditorState.phrases`（zh 本地化）。
- **行号**：默认 gutter；不渲染当前行高亮（无光标语义）。
- **软换行默认关**（桌面代码浏览惯例，长行横向滚动）；不做换行切换（见不做的事）。
- **选中复制**：不装 drawSelection，选区走原生 `::selection`（app.css 令牌化）；Ctrl+C 浏览器默认。
- **doc 同步**：激活重拉后 `content` 变化 → 长度快路径 + `view.dispatch` 整体替换（保滚动位置）；不重建 EditorView（key 隔离已处理换文件）。
- **焦点**：cm-content 参与键盘 Tab 序（contenteditable 天然行为）——文件视图内容是主内容，与消息流「内容不入焦点序列」的取舍不同。

### 2.4 主题：class 化 + CSS 变量

- HighlightStyle 用 **class** 而非内联色（openchamber `syntax` 层同法）：`.cm-comment/.cm-keyword/.cm-string/.cm-number/.cm-function/.cm-type/.cm-tag/.cm-operator/.cm-punctuation/.cm-variable/.cm-link`。
- 颜色在 app.css 用 `--syntax-*` 令牌（tokens.css 定义 dark/light 两套，GitHub light/dark 色板取值——两主题下代码可读性经过大规模验证）。`data-theme` 切换即生效，无需重建编辑器。
- 编辑器 chrome（背景/前景/gutter/选区/搜索面板）同样令牌化；CM 自身不 import 任何显式 theme 扩展。注意 CM baseTheme 仍无条件注入（Prec.lowest、样式插在 head.firstChild）——app.css 文档序靠后，同特异性时后者胜（CM 设计的覆写途径，app.css 有注释言明）。选区不装 drawSelection，走原生 `::selection` 令牌化。

### 2.5 FileView 集成

- 非 markdown 文本文件：`<pre>` → `<CodeView path content />`。
- markdown 源码态：同样 `<CodeView>`（lang-markdown）；预览态不变。
- 加载/错误态不变。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 编辑/保存 | 文件 Tab 是浏览语义；编辑是独立大功能 |
| 软换行切换按钮 | 无用户诉求；CM lineWrapping 后续一个 compartm­ent 就能加 |
| 折叠/大纲/跳行 | basicSetup 级功能，浏览优先级低 |
| shiki 双轨高亮 | openchamber 为主题兼容所迫；本项目单一 CSS 变量体系无此需求 |
| 大文件门限（异步高亮降级） | CM 增量解析天然延迟着色；移动端 >2000 行降级是 Flutter 手搓方案的补丁，不适用 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `package.json` | +17 个 @codemirror 依赖 |
| `src/renderer/src/components/code-view.tsx` | 新：React 壳 |
| `src/renderer/src/components/cm-lang.ts` | 新：语言映射 |
| `src/renderer/src/components/cm-theme.ts` | 新：HighlightStyle + theme spec |
| `src/renderer/src/components/workspace.tsx` | FileView 源码态接入 CodeView |
| `src/renderer/src/styles/tokens.css` | `--syntax-*` 双主题令牌 |
| `src/renderer/src/styles/app.css` | `.cm-*` 样式 |
| `src/renderer/src/components/code-view.test.tsx` | 新：映射单测 + 渲染冒烟 |

## 5. 验收

- 打开 ts/py/json/md（源码态）等文件：行号 + 语法高亮 + 主题切换正确；未知扩展名纯文本带行号；
- Ctrl+F 搜索面板可用；选中可复制；
- `npm run test` / `npm run typecheck` 全绿。
