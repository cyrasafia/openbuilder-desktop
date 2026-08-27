# PDF 预览（文件 Tab）— 设计文档

> 对应 spec-v0.3 #7。PDF 文件在文件 Tab 内预览，与图片预览同体系：仅预览态（无预览/源码切换）、随文件监听刷新。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder/docs/design-file-view.md`（移动端 PDF 走系统打开/下载，无内嵌渲染——无移动端可借鉴）；本仓库 `design-image-preview.md`（分支入口/二进制判定/刷新链路同构）与 `design-browser-tab.md`（WebContentsView 基建复用）。

## 0. 路线实测记录（2026-08-27，Electron 43 打包形态 CDP）

| 路线 | 结果 |
|---|---|
| `<iframe src=blob:>` / `<embed>` / `<object type=application/pdf>`（plugins:true） | ✗ Chromium PDFium 查看器不接管 renderer 内嵌（空文档；主进程 will-frame-navigate 曾拦截 blob 子帧是伴生现象，非根因——子帧拦截已恢复全拦） |
| pdfjs-dist 自渲染（canvas 逐页） | ✗ 打包形态 renderer 是 file://——Worker 构造静默挂起（workerSrc=file:// 与 blob: 模块 Worker 均然）；主线程注入（globalThis.pdfjsWorker）后 getDocument/getPage 通、**render promise 死锁**（8s race 确认） |
| **专用 WebContentsView + 顶层 file:// 导航** | ✓ PDFium 扩展查看器（chrome-extension://mhjfbmdgcfj…）接管渲染，CDP target 列表实证 |

## 1. 终态方案

- **分支入口**：`isPdfPath`（`.pdf` 扩展名，大小写不敏感）→ 仅预览态（无工具条切换——源码对 PDF 无意义，同图片先例）
- **可用性判定先行**：`/file/content` 快照——错误 → 错误态；非 binary → 二进制占位（同图片分支模式）；通过才挂视图
- **渲染**：`PdfFrameView`（pdf-frame-view.tsx）——文件 Tab 内嵌**专用 WebContentsView**：
  - 懒建（挂载首帧 `browser:view-create`，view 的 webPreferences 带 `plugins: true`——PDFium 必需）→ 注册进 store `browserViewIds`（key = `file:<绝对路径>`，与浏览器 Tab 同注册表）→ `browser:navigate(fileUrlOf(path))`
  - bounds 随宿主 div（ResizeObserver + rAF 合帧）；卸载仅隐藏（内容保留）；**关 Tab 经 closeTab 的注册表兜底统一 dispose**（不限 kind，PDF 文件 Tab 与浏览器 Tab 共用）
  - 显隐随激活/overlay 协调（syncBrowserViewVisibility 按 key 匹配激活 Tab，不分 kind）
- **刷新**：文件监听重拉 content → 快照变化触发重挂载分支（binary 判定链）——视图对同一 file:// URL 的重导航不必须（内容变化场景用户重开 Tab 即见，v0.3 取舍）；错误态自然呈现
- **浏览器 shim**：view-create 返回 -1 → 停留 loading 占位（无回退渲染，纯浏览器 dev 非 PDF 验收环境）

## 2. 不做的事

- 源码态切换、缩放/搜索/页码控制（PDFium 自带工具条）、打印
- PDF 内链接拦截（PDFium 自行处理外链——系统浏览器）
- 增量刷新推送（文件监听 → 重导航；v0.3 重开可见）
- pdfjs-dist 依赖（已移除——实测死锁，见 §0）

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/components/pdf-frame-view.tsx` | 新：PDF 视图宿主（懒建视图/注册/导航/bounds 同步） |
| `src/renderer/src/components/workspace.tsx` | `isPdfPath` + FileView pdf 分支（快照判定 → PdfFrameView） |
| `src/renderer/src/store/app-store.ts` | `registerFileTabView`；closeTab 视图 dispose 按**注册表命中**（不限 browser kind）；显隐协调按 key |
| `src/main/browser-views.ts` | view webPreferences `plugins: true`（PDFium 必需） |
| `src/renderer/src/styles/app.css` | `.file-view.pdf-view`（宿主满幅） |
| 测试 | file-view：pdf 分支分发（宿主 stub 透传路径）/占位/错误 |

## 4. 验收（对齐 spec #7）

- 打开 .pdf：文件 Tab 内 PDFium 渲染（CDP 实测扩展查看器接管 ✓ 2026-08-27）；文件 Tab 标题 = 文件名
- 非 pdf 二进制仍走占位；切走隐藏/切回恢复；关 Tab 视图 dispose
- `npm run test`/`typecheck`/`build` 全绿
