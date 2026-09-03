# 左右栏收起/展开 — 设计文档

> 对应 spec-v0.3 #1。左/右栏收起后**完全不展示**；收起/展开按钮放在标题栏右侧、最小化按钮左边；折叠态与栏宽持久化，重启还原；补齐拖拽调宽（design-layout §2 的 v0.2 遗留）。
>
> 参考先例：按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`，移动端无桌面三栏布局（单栏 + 抽屉），无同类设计；本功能为桌面端原生，无移动端可借鉴坑。

## 1. 现状

- 三栏 grid（`.app-shell`）：`var(--sidebar-w, 260px) | minmax(0,1fr) | var(--filepanel-w, 300px)`——两个 CSS 变量**无 JS 写入点**，恒用默认值，无拖拽调宽
- `StoreShape["layout.state"]`（src/shared/ipc.ts）已预留 `{leftWidth, rightWidth, leftCollapsed, rightCollapsed}`，但 renderer 从未读写——持久化管道现成
- TitleBar 仅 `platform==="linux"` 渲染（app.tsx Shell 门控）；内含拖拽区 + 最小化/最大化/关闭三按钮
- design-layout §2 原文："折叠后仅留项目图标条（48px）"（左）/"折叠后隐藏，工具栏按钮唤回"（右）——**本文修订为：两栏折叠后均完全不展示，按钮统一放标题栏**（用户决策 2026-08-27）

## 2. 设计

### 2.1 形态与入口

- 收起 = 栅格列宽 0 + 面板 `display:none`（无窄条、无图标条残留；面板内不可聚焦元素随卸载退出 Tab 序列）
- 入口 = 标题栏右侧两个开关按钮，**最小化按钮左边**，先左栏后右栏（lucide `PanelLeft` / `PanelRight` 各一枚，图标不随状态切换——按钮是开关不是状态指示，tooltip 随状态切换文案）
- **键盘入口：Ctrl+[ 左栏 / Ctrl+] 右栏收起/展开**（翻转语义，与标题栏开关同路径 toggle，分发见 design-keyboard-shortcuts §1；终端 Tab 聚焦时键归 xterm 不生效——冲突核查结论 2026-09-03 亦在该文档）
- **TitleBar 改为全平台渲染**（app.tsx 去掉 linux 门控）；拖拽区与窗口控制三按钮仍仅 linux（frameless 才有意义）。非 linux/浏览器 shim 下标题栏 = 居中标题 + 两个开关，无窗口控制（系统装饰已有）

### 2.2 store 状态与持久化

```ts
layoutLeftWidth = 260   // clamp [200, 360]
layoutRightWidth = 300  // clamp [240, 480]
layoutLeftCollapsed = false
layoutRightCollapsed = false
```

- `doInit` 与 theme/locale 一并从 `layout.state` 整体读入（缺省值即上表）
- `toggleLeftPanel()` / `toggleRightPanel()`：翻转 + emit + 整体写回 `layout.state`
- `setPanelWidth(side, px)`：clamp 后写内存 + emit，**不落盘**（拖拽逐帧调用，写放大防护）；`persistLayout()` 在拖拽 pointerup 时调用
- IPC 写失败静默（内存态与持久态暂时不一致，重启回退旧值——同 tabs.memory 取舍）

### 2.3 栅格接线

Shell（app.tsx）按状态生成 `grid-template-columns` 内联样式：

```
collapsed ? "0px" : `${layoutLeftWidth}px` | minmax(0,1fr) | collapsed ? "0px" : `${layoutRightWidth}px`
```

不再依赖 `--sidebar-w`/`--filepanel-w` 变量（无第二写入点，单一来源）；面板折叠时同步 `data-collapsed` 或直接条件卸载（`display:none`，组件仍挂载——文件树状态/滚动不因收起丢失，展开即恢复，与"切走保存"心智一致）。

### 2.4 拖拽调宽

- 手柄：两栏**内缘**各一条（`.sidebar-resize` 右缘 / `.filepanel-resize` 左缘），绝对定位 6px 命中区（面板内、不跨界——面板 `overflow:hidden` 会裁掉外侧）、`cursor: col-resize`、hover 亮 1px 分隔线，折叠态随面板 `display:none` 消失
- Pointer Events + `setPointerCapture`（try/catch 包裹）：move 逐帧 `setPanelWidth`（emit 驱动栅格变量重算，等值去抖），up 时 `persistLayout()`
- 宽度计算 = **按下时面板宽快照 + 位移增量**（左栏 `+dx`、右栏 `-dx`）——不逐帧读面板实时 rect：emit 改变面板宽，实时 rect 会形成反馈回路
- 拖拽期间给 `<html>`（`:root`）挂 `resizing` 类（含 portal 等全部子帧）：`iframe/embed/object { pointer-events: none }`——文件 Tab 的 html 预览 iframe（及后续版本的嵌入视图）不吞 pointer；up/cancel/组件卸载时移除

### 2.5 i18n

| key | zh | en |
|---|---|---|
| `collapseLeftPanel` | 收起左栏 | Hide sidebar |
| `expandLeftPanel` | 展开左栏 | Show sidebar |
| `collapseRightPanel` | 收起右栏 | Hide file panel |
| `expandRightPanel` | 展开右栏 | Show file panel |

## 3. 不做的事

- 折叠动画（面板进出用 width 过渡会引起 grid 重排抖动，直接切换；后续有诉求再议）
- 每栏独立的悬浮唤出条（用户明确不要残留物）
- 记住"哪个栏在哪个项目下折叠"——布局状态全局一份，不按作用域分域
- 工作区中栏收起（永远是主内容区）

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | 四个布局字段 + doInit 读取 + toggle/setPanelWidth/persistLayout（Ctrl+[ /] 复用 toggle，无新增方法） |
| `src/renderer/src/app.tsx` | TitleBar 全平台渲染；Shell 栅格列内联计算；resizing 类接线 |
| `src/renderer/src/components/title-bar.tsx` | 两个面板开关按钮（useStore） |
| `src/renderer/src/components/sidebar.tsx` | 左栏内缘手柄 |
| `src/renderer/src/components/file-panel.tsx` | 右栏内缘手柄 |
| `src/renderer/src/styles/app.css` | `.title-bar-btn.panel-toggle`、`.sidebar-resize`/`.filepanel-resize`、`:root.resizing` iframe 屏蔽 |
| `src/renderer/src/i18n/index.ts` | 4 个 tooltip key |
| 测试 | title-bar 组件用例（开关按钮 + tooltip 态）、store 布局用例（读入/toggle/宽度 clamp/持久化） |

## 5. 验收

- 标题栏最小化按钮左侧两开关，点击收起/展开对应栏，收起后无任何残留；tooltip 随状态切换
- 拖拽调宽实时生效且受 min/max 约束；宽度与折叠态重启还原
- 非 linux/浏览器 shim 下标题栏渲染开关、不渲染窗口控制；`npm run test`/`typecheck`/`build` 全绿
