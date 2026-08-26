# Tab 拖拽重排序与 chat Tab 重命名 — 设计文档

> 对应 spec-v0.3 #3。Tab 条内 HTML5 拖拽重排序；重命名仅限 chat Tab（= 会话重命名）。纯 renderer 改动。
>
> 参考先例：按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`——移动端无 Tab 条（单会话路由），无同类设计。

## 1. 拖拽重排序

- `.tab` 元素 `draggable`；dragstart 记拖拽 key（`dataTransfer.setData("application/x-openbuilder-tab", key)` + `effectAllowed/dropEffect = "move"`——自定义 MIME 避免内部 key 以 text/plain 拖入可编辑区被默认插入）；dragover 阻止默认 + **按命中半区指示**（目标左半 = 左缘 2px primary 线、插入目标前；右半 = 右缘线、插入目标后——末位可达）；drop → `store.moveTab(dragKey, targetKey, before|after)`；dragend/drop 清指示，dragleave（真正离开该 Tab，非进出子元素）清指示防滞留
- **`moveTab(dragKey, targetKey, position)` 作用于全局 `tabs` 数组**（作用域视图是投影）：按落位（目标前/后）换算插入点，纯数组重排，跨作用域 Tab 的相对顺序不受影响；**位置无变化早退**（不发 emit——相邻 no-op 落放不触发重渲染）
- chat Tab 移动后 `syncScopeMemory(directory)`：顺序经既有记忆派生落盘（design-tab-memory §3.2"顺序语义由记忆结构预留，拖拽落地后天然兼容"兑现）；file/diff Tab 不参与记忆（既有决策）
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
| `src/renderer/src/store/app-store.ts` | `moveTab(dragKey, targetKey, position)`（含 chat 记忆同步、no-op 早退）；`renameSession` |
| `src/renderer/src/components/workspace.tsx` | Tab 拖拽事件接线 + drag-over 指示 + 行内重命名输入框 |
| `src/renderer/src/styles/app.css` | `.tab.drag-over` 指示线、`.tab-label-input` |
| 测试 | store：moveTab 顺序（前插/跨作用域不扰/记忆派生）、renameSession 成功/失败 |

## 5. 验收

- 拖动 Tab 到另一 Tab 左/右半区 → 插入目标前/后（末位可达）；切走再切回、重启顺序保持（chat 记忆）
- 双击 chat Tab 重命名，Enter 生效（Tab 标题 + 引导页归档列表同步）；Esc 取消；file/diff Tab 双击无反应
- `npm run test` / `typecheck` / `build` 全绿
