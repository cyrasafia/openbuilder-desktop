# Tab 拖拽重排序与 chat Tab 重命名 — 设计文档

> 对应 spec-v0.3 #3。Tab 条内 HTML5 拖拽重排序；重命名仅限 chat Tab（= 会话重命名）。纯 renderer 改动。
>
> 参考先例：按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`——移动端无 Tab 条（单会话路由），无同类设计。

## 1. 拖拽重排序（2026-08-29 修订：实时预览 + 所见即所得）

> 初版为"命中半区 + 指示线"式（悬停目标缘亮 2px primary 线、drop 才落位）。
> 左栏项目行拖拽（[design-project-drag-reorder.md](./design-project-drag-reorder.md)）
> 实测演进出**实时预览 + 所见即所得**模式后，Tab 条同日迁移到该模式：预览式消除
> "指示线位置 ≠ 最终位置"的心智换算，交互与左栏统一。指示线式废弃。

- `.tab` 元素 `draggable`；dragstart 记拖拽 key（`dataTransfer.setData("application/x-openbuilder-tab", key)` + `effectAllowed = "move"`——自定义 MIME 避免内部 key 以 text/plain 拖入可编辑区被默认插入）
- **实时预览**：dragover 挂 `.tabbar` 容器（Tab 级无 dragover），按光标 X 遍历预览序 Tab 做**边缘带几何判定**（项目行判定的水平化）：光标落入某 Tab 左 25% 区域 = 插其前、右 25% = 插其后（末位可达），**中间 50% = 滞回带**维持当前插入位（预览换位后 Tab 移位，滞回带吸收移位量防抖）；Tab 间空隙/首 Tab 左侧 = 最近边界；**末位 Tab 右半以远全部区域（含条尾空白 / "+" 按钮）= 末位**；悬停占位 Tab 自身 = 维持当前插入位；判定用 `hit` 标记区分"行内滞回（不动）"与"未命中任何 Tab（末位）"（两态共用 null 会把中带误判成末位，项目行实测同坑）。拖动中 Tab 条**即时重排**：拖拽项在目标插入位渲染**占位样式**（`.dragging`：虚线框 + 降不透明度，压过 active 底色/下划线、藏关闭钮），源位间隙闭合；坐标系 = **移除拖拽项后的作用域数组**（slot 0..base.length），悬停行下标换算回 base 下标再算命中，防"行移位→悬停漂移→预览回跳"；dragover 高频触发：同值保留旧引用 React bail out
- **落位挂 `dragend` 而非 `drop`**（项目行同款关键修订）：drop 只在松手点位于 dragover 被 preventDefault 的合法落区内才触发——Tab 条外、快速拖动越界松手时浏览器直接取消拖拽、只发 `dragend`；`dragend` 在源元素上恒触发，任何释放位置都提交。提交内容 = **松手时预览 DOM 序**：读 tabbar 容器内 `.tab` 的 `data-tab-key` 顺序调 `store.applyTabOrder(keys)` **整体重排**——所见即所得，**不经 slot→目标键换算**（换算依赖最后一次 dragover 的状态提交，存在竞态窗口——预览已渲染新位、闭包还持旧 slot，项目行实测同坑；DOM 是用户看到的唯一事实）。容器 `onDrop` 仅保留 preventDefault。原生拖拽期间页面收不到键盘事件（Chromium 嵌套拖拽循环），无 Esc 取消路径——任何方式结束拖拽均提交预览序（与项目行同取舍）
- **`applyTabOrder(keys)` 作用于全局 `tabs` 数组**（作用域视图是投影）：可见 Tab 的槽位按 keys 序**逐槽回填**，非可见 Tab 槽位与跨作用域 Tab 的相对顺序不受影响；keys 去重、未知键忽略（拖拽中列表变化的防御）；**顺序无变化早退**（不发 emit——相邻 no-op 落放不触发重渲染）
- chat Tab 顺序经记忆派生落盘（design-tab-memory §3.2 预留的顺序语义兑现）：**仅重排含 chat Tab 时同步**（纯 file/diff 重排的派生结果不变，不产生冗余落盘——write discipline 同旧 `moveTab`）；可见 Tab 同属一个作用域目录，`syncScopeMemory(作用域目录)` 一次覆盖；file/diff Tab 不参与记忆（既有决策）
- 拖拽中 Tab 被移除的兜底（review 发现）：他端删会话经 SSE `closeTab` 卸载源 `.tab` 节点后 `dragend` 不再派发，残留 dragKey 会让容器 dragover 对后续无关拖拽误 preventDefault——dragKey 失效检测（Tab 集不含 dragKey 即清拖拽态）兜底，与预览侧 dragIdx 守卫（拖拽中回原序）互不依赖
- 重命名态（§2）中该 Tab 暂停 draggable（输入框内文本选择优先）；关闭按钮点击已 stopPropagation，不受拖拽影响
- 仅当前作用域可见 Tab 间可排（拖拽只发生在可见集合内，跨作用域 Tab 不在 Tab 条上、无交互面）

## 2. 重命名（仅 chat Tab = 会话重命名）

- **双击** chat Tab 标签 → 行内输入框（本地态 `renaming: { key, value }`）：autoFocus + 全选；`Enter`/失焦提交（trim 后非空且有变化），`Esc` 取消；**IME 组合中（isComposing）不触发**（fcitx5 上屏/取消候选）；输入框 click/mousedown stopPropagation（不触发 Tab 激活）、不参与拖拽、**键盘事件不 blanket stopPropagation**（全局快捷键在重命名中仍可用）；双击另一 chat Tab 切换编辑目标时先提交旧的（未提交内容不静默丢失）
- `store.renameSession(sessionID, title)`：`PATCH /session/{id}` `{ title}`（rest-client `updateSession` 既有）→ 成功合并回 `sessionsByProject`（`mergeSessionUpdate`，与 session.updated 事件同路径）并**即时同步 Tab 标题**（SSE 回环亦可到达，此处消除本地等待）；失败 `connectionError` 呈现、标题不变
- 他端重命名经既有 `session.updated` 事件同步 Tab 标题（app-store `session.updated` 分支已实现，v0.1 注释"重命名 UI 无入口"至此兑现）；重命名非 chat Tab 不提供（文件名/diff 无会话语义）
- app-store.ts:2066 附近原注释（"重命名/删除会话的 store 方法随 v0.1 会话卡片菜单一并移除"）随本功能更新

## 3. 不做的事

- 拖出主窗口成窗、跨作用域拖拽、拖到引导页"+"按钮的语义
- 会话删除入口（仍无，v0.1 已知取舍）
- 重命名的历史/撤销
- Tab 条组件化抽取（现内联于 Workspace；UI 接线薄，store 侧逻辑有测试覆盖）

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `applyTabOrder(keys)`（预览 DOM 序逐槽回填 + chat 记忆同步 + no-op 早退；2026-08-29 修订替代初版 `moveTab`，后者落位换算语义已被整体式提交取代，删除）；`renameSession` |
| `src/renderer/src/components/workspace.tsx` | Tab 容器级 dragover 边缘带几何 + dragend DOM 序提交 + 预览渲染；行内重命名输入框 |
| `src/renderer/src/styles/app.css` | `.tab.dragging` 占位样式、`.tab-label-input`（原 `.tab.drag-over` 指示线废弃） |
| 测试 | store：applyTabOrder（整体重排/跨作用域槽位不动+记忆派生/未知键去重/no-op 早退）、renameSession 成功/失败 |

## 5. 验收

- 拖动中 Tab 条即时重排（占位样式随光标连续移动，不回跳、不丢失）；松手任何位置（含 Tab 条外/快速越界）均按松手时预览序落位；顺序无变化不产生 emit
- 切走再切回、重启顺序保持（chat 记忆）；跨作用域 Tab 相对顺序不受扰
- 双击 chat Tab 重命名，Enter 生效（Tab 标题 + 引导页归档列表同步）；Esc 取消；file/diff Tab 双击无反应
- `npm run test` / `typecheck` / `build` 全绿
