# 文件 Tab 图片预览 — 设计文档

> 目标：文件 Tab 打开图片文件（png/jpg/jpeg/gif/webp/avif/bmp/ico/svg）时渲染图片预览（点击切换 适应窗口 ↔ 原始尺寸）；非图片二进制文件不再把 base64 当文本灌进代码视图，改为占位提示。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-file-view.md`「图片 Mode」——格式集合（jpeg/png/gif/webp/svg）、自动预览、无导出入口；渲染分发决策 #3：**SVG 按扩展名判断，服务端对 SVG 返回 `type:"text"` 且无 mimeType**
> - `openbuilder/docs/design-image-attachment-thumbnail.md`——消息附件图片的判定经验：图片性判定以「内容类型」为准（本功能落到 mimeType/扩展名），解码失败降级兜底而非卡死
> - 移动端「捏合缩放 + 平移」在桌面对应为「滚轮缩放 + 拖动平移 + 点击快捷切换」（§2.4；2026-08-25 增补滚轮/拖动，初版仅点击二态）

## 1. 问题

`GET /file/content` 对图片返回 `{type:"binary", content:<base64>, encoding:"base64", mimeType:"image/png"}`，但 `readFileContent` 只取 `content` 字符串——图片被当文本塞进 CodeMirror，渲染兆字节级 base64 串，既不可读又卡顿。二进制文件同病。

**契约实测（2026-08-25，本机 server localhost:15120）**：

- PNG → `{type:"binary", content:<base64>, encoding:"base64", mimeType:"image/png"}`（302KB 图，正常返回）
- SVG → `{type:"text", content:"<svg…>"}`（**无 mimeType 字段**——与移动端决策 #3 记录一致）
- FileContent schema（openbuilder/opencode_openapi.json）：`type: "text"|"binary"`、`content`、`encoding: "base64"|undefined`、`mimeType?: string`

## 2. 设计

### 2.1 数据层：还原完整 FileContent

- `rest-client.readFileContent` 返回完整对象 `FileContentData { type; content; mimeType?; encoding? }`（原来只返回 `content` 字符串，丢弃了二进制判定所需字段）。响应校验不变（`content` 必须为字符串）。
- store `fileContents` 缓存值扩展：`{ content; binary?; mimeType?; error? }`——`binary = type==="binary"`。两条加载路径（`loadFileContent` 激活重拉 / `doFileReload` 监听重拉）同改。

### 2.2 FileView 分发（扩展名，与 md/html 同规则）

`isImagePath`：basename 最后一个非前导点的后缀，大小写不敏感：

| 扩展名 | 渲染 |
|---|---|
| `png/jpg/jpeg/gif/webp/avif/bmp/ico` | 位图分支（数据源须 `binary && mimeType image/*`） |
| `svg` | 矢量分支（数据源为 `type:"text"` 源码） |

- 移动端格式集是 jpeg/png/gif/webp/svg（Flutter 引擎所限）；桌面 Chromium 原生解码 avif/bmp/ico，零成本纳入。
- 分发只按扩展名（与 isMarkdownPath/isHtmlPath 一致），加载态即可确定分支；渲染时再按 §2.1 字段兜底（扩展名说图片但服务端返回 text/非 image mime → 回落代码视图/二进制占位，不硬渲染坏图）。
- **无工具条**（无源码态可切——位图源码无阅读价值；svg 源码想看可走代码文件路径打开，不为此加分支；移动端同决策「图片/二进制：无额外 action」）。

### 2.3 图片渲染

- 位图：`<img src="data:${mimeType};base64,${content}">`——mimeType 缺省时按扩展名映射兜底。
- **data URL 拼接走 `useMemo`**（2026-08-25 评审修复）：兆字节级字符串，而 store 订阅在 App 层、FileView 非 memo——agent 流式期间每条 SSE emit 都触发重渲染，不可每次重建（同 `htmlDoc` 既有决策）。
- **显式尺寸与 `zoomed` class 以 `nat` 落地为前提**：Chromium 头部嗅探使 `naturalWidth` 先于 load 事件可用，滚轮可能先设 `scale`——此时若已挂 `zoomed` class（解除 max 约束）而无显式尺寸，会以 1:1 原始尺寸闪一窗口期；`nat` 落地前保持适应窗口渲染，落地后缩放随显式尺寸一并生效。
- **`nat` 登记不依赖 React `onLoad`——每次渲染检查 `img.complete` 兜底**（2026-08-25 三报故障的根因，CDP 实测锁定）：启动后首个图片 Tab 实测 `complete=true`、`naturalWidth` 已就位而 `onLoad` 未触发（img 的 load 事件绕过/先于 React 监听落地），`nat` 永不落 → 缩放渲染门槛永不满足：滚轮 handler 正常运行（`preventDefault` 生效、`aria-pressed=true`、`scale` 已设）却无视觉变化，且不自愈；重开/切走切回 = 重挂载换 load 时序才恢复——这正是前两轮按「监听未挂载」修（useEffect→回调 ref）无效的原因（监听始终在容器上，`DOMDebugger.getEventListeners` 可证）。兜底为无依赖 `useLayoutEffect`：任何一次渲染发现 `img.complete` 且宽高均就位（与 `onLoad` 路径同口径，防退化 0 尺寸）即补登记 `nat`；滚轮/点击触发的重渲染保证至迟下一次交互即生效。**锚定/居中的滚动消费同样以 `nat` 为门槛**（评审修复）：竞态下首个滚轮刻 `scale` 先落、`nat` 未落，该帧仍是适应窗口布局，若此时消费锚点会对错误布局换算（光标下的点跑到左上角）——故 effect 依赖带 `nat`，未落时不消费、落地重跑再对真实放大布局换算；滚轮/点击并互清对方挂起的滚动意图，防竞态滞留标志被后续交互误消费。
- SVG：`<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}">`。**`<img>` 中的 SVG 不执行脚本**（浏览器规范行为），无 html 预览那套 CSP/沙箱需求。不用 `<object>`/内联注入（那才需要脚本防线）。
- GIF 动图：`<img>` 原生播放，无额外处理。
- 解码失败（`<img>` error 事件）：组件局部 error state → 错误态文案（与加载失败同样式），不静默 broken icon（openbuilder 附件侧「解码失败降级」的同位决策）；内容重拉（src 变化）重置失败态。失败态重置走 `useEffect([src])` 而非 `key={src}`——src 是兆字节级 data URL，不宜作 React key。

### 2.4 交互：滚轮缩放 + 拖动平移 + 点击快捷切换

移动端图片 Mode 是「捏合缩放 + 平移」（触屏语义）；桌面对应为鼠标语义三件套。初版仅落地点击二态，诉求出现后（2026-08-25）增补滚轮/拖动。

- 默认**适应窗口**（`zoomed = false`）：图居中，`max-width/max-height: 100%`，等比（`object-fit: contain`）。
- **滚轮：连续缩放，光标锚定**。缩放系数相对**原始尺寸**（1 = 1:1），指数步进 `e^(-deltaY×0.002)`（单滚轮刻 ≈1.22×），区间 `[0.05, 16]`；`deltaMode: 1`（Firefox 行模式）折算 ×16。光标锚定：缩放前后光标下的图像点保持不动（滚动偏移换算见下）。适应窗口态滚轮即进入手动缩放，起点比例取**当前渲染宽 / 原始宽**（不重算容器几何，直接量渲染结果）。**当前比例在滚轮回调内写穿 `scaleRef`**（2026-08-25 评审修复）：wheel 是连续事件，React 19 不逐事件刷新渲染，同一批渲染内到达的多个事件若都从「渲染期同步的 ref」取值，会读到同一旧值、N 刻塌缩为 1 步——触控板捏合（高频小 `deltaY`）与高回报率鼠标平滑滚动下缩放近乎无响应；回调内回写使批内事件链式累加。
- **拖动：按住平移**。位移 >3px 判定为拖动（进入 `grabbing` 光标态），经容器 `scrollLeft/Top` 平移；适应窗口态无溢出，拖动自然无效果。
- **点击（未拖动）：快捷切换 适应窗口 ↔ 1:1**——初版二态交互保留为快捷复位；拖动结束后的 click 被位移阈值判定抑制，避免拖完误触切换。**切换监听挂在容器而非 `<button>`**（2026-08-25 修订，实测修复）：拖动用的 `setPointerCapture` 会把 pointerup 派生的 click 重定向到捕获元素（容器），button 自身 `onClick` 在真实 Chromium 永不触发（jsdom 不实现指针捕获、合成 click 直达目标，单测绕过该行为，需用真实 Electron 才暴露）；键盘点击 button 冒泡到容器，两路统一。`<button>`（包裹 img）保留键盘可达与 `aria-pressed`（表达 适应/手动 二态）——与文件视图「内容是主内容」的焦点决策一致（design-code-view §2.3）。
- **缩放渲染不用 `transform`**：transform 不参与布局，滚动容器拿不到放大后的滚动范围；改用显式 `width = naturalWidth × scale`（height auto）。原始尺寸取自 `img` 的 `onLoad`（`naturalWidth/Height`；为 0 不落地，防解码异常）。
- **光标锚定与居中的滚动设置放在 `useLayoutEffect`**（绘制前，避免每个滚轮刻以旧滚动位置闪一帧）：state 更新异步，滚轮回调里拿不到新布局的尺寸。**锚点按「光标在图内的分数位置 + 光标视口坐标」记录，新尺寸落地后按 img 实测位置换算 `scrollLeft/Top`**（2026-08-25 修订，评审实测修复）：不能按新旧比例匀缩「内容坐标」——滚动内容 = 按钮 padding box，恒定 16px padding 不参与缩放，匀缩假设每刻漂移 `16(ratio-1)` 且复利累积（10 刻漂移约 100px）；`margin:auto` 居中偏移在「居中→溢出」过渡的一次性跳变同样只有实测能吸收。点击切换则落地后滚动居中（`(scrollWidth - clientWidth)/2`）。
- **滚轮监听必须原生 `passive: false`**：React 根监听器对 wheel 是 passive，`preventDefault` 无效，容器会跟着滚。**挂载走回调 ref 而非 `useEffect`**（2026-08-25 修订）：注册/清理与节点生命周期绑定。初次打开经过 加载态→预览体 分支切换，容器节点由不同渲染路径先后产出；`useEffect([failed])` 一次性读 ref 挂载与节点生命周期脱钩——实测初次打开滚轮落回默认滚动、重开（缓存命中直挂）才恢复缩放，即监听未落在当前可见节点。回调 ref 节点挂载即注册、卸载即清理，任何分支切换/节点更换都自动跟随。
- 缩放态/比例为组件局部 state（随 Tab key 隔离，不持久化，同 md/html 模式 state）。
- 不做缩放百分比指示器：浏览语义，数值反馈是增量收益。

### 2.5 非图片二进制占位

`binary === true` 且不走图片分支（`.zip`/`.woff2`/`.bin` 等）：占位提示 `binaryUnsupported`（中性样式，非错误红——文件存在，只是不预览）。替代现状的 base64 文本倾泻。不提供下载/外链打开（移动端同决策「看是目的」；桌面无移动端「导出才能看」的诉求）。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 图片导出/下载/分享 | 移动端同决策（「图片不提供导出」） |
| 缩放百分比指示器 | 见 §2.4：浏览语义，数值反馈是增量收益 |
| 触摸捏合缩放 | 桌面鼠标语义优先（滚轮/拖动已覆盖）；触屏设备后续诉求再说 |
| 图片元信息（尺寸/色彩空间/文件大小） | 移动端同列不做；元信息是增量收益 |
| SVG 源码/预览二态工具条 | 见 §2.2：不为单一格式加交互分叉 |
| 多图并排/缩略网格 | 文件 Tab 单文件语义，无此场景 |
| 内容嗅探（扩展名与真实类型不符时纠正） | 与 md/html 分发同决策：只按扩展名，异常回落兜底分支 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/rest-client.ts` | `readFileContent` 返回 `FileContentData` 完整对象 |
| `src/shared/api-types.ts` | `FileContentData` 类型 |
| `src/renderer/src/store/app-store.ts` | `fileContents` 值扩展 `binary?/mimeType?`；`loadFileContent`/`doFileReload` 落地新字段 |
| `src/renderer/src/components/workspace.tsx` | `isImagePath` + 图片分支（img 渲染 + 缩放切换 + 解码失败态）+ 二进制占位 |
| `src/renderer/src/i18n/index.ts` | `binaryUnsupported` / `imageZoomToggle` 文案 |
| `src/renderer/src/styles/app.css` | `.file-view.image-view` / `.image-zoom` |
| `src/renderer/src/components/file-view.test.tsx` | 图片分发/渲染/缩放/二进制占位用例 |

## 5. 验收

- 打开 `.png`/`.jpg` 等：渲染图片（适应窗口、居中）；点击切 1:1（容器可滚动、滚动居中），再点回落；
- 滚轮连续缩放（光标锚定、区间 `[0.05, 16]`），适应窗口态滚轮即进入手动缩放；按住拖动平移（>3px 判定，`grabbing` 光标），拖动后的点击不误触切换；
- 打开 `.svg`：矢量渲染；GIF 自动播放；
- 打开非图片二进制（`.zip` 等）：占位提示，无 base64 文本；
- 图片加载/解码失败：错误态文案；文本/代码文件行为不变；
- `npm run test` / `npm run typecheck` 全绿。
