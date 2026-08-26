# 文件引用（@ / 右键 / 拖拽）— 设计文档

> 对应 spec-v0.3 #4。把当前作用域的文件/目录**引用**进消息（`FilePartInput.source`，零字节、server 注入内容）。三入口：输入框 `@` 搜索浮层、文件树右键、文件树拖拽进输入框。
>
> 参考来源（按 AGENTS.md 约定先行检索）：`../openbuilder/docs/design-file-reference.md`——引用协议（FilePartInput + FileSource）与全部实测契约（absolute url 必需、mime 占位、source.text 留空、二进制回灌重写、目录注入 entries、发送守卫三处扩展、斜杠命令 parts 同样携带）均移植自该文档，本设计按桌面交互重组并注明差异。检索结论：移动端明确**不做** `@` 文本触发 picker（手机键盘场景），桌面端为用户明确需求——`@` 浮层为桌面新增设计。

## 1. 契约事实（继承移动端实测 + 本轮 openapi 复核）

| 事实 | 来源 |
|---|---|
| `url` 必须 absolute `file://<绝对路径>`：相对/path 缺失会被 server **静默丢弃**（prompt_async 返 204 无 user 消息） | 移动端实测表 |
| `mime` 占位 `text/plain` 即可：server 按 url 读真实内容；文本/目录回灌 mime 不变，二进制按真实类型重写（`fileUrl` 变 `data:…`） | 移动端 3R-B 实测 |
| `source.text` 留空（`{value:"", start:0, end:0}`）：无需在正文插 `@path` 子串 | 移动端实测 |
| 目录引用：server 注入 `<entries>`（Read tool 列目录），`mime` 占位同样接受 | 移动端实测 |
| server 把 file part 翻译成 Read tool 调用注入历史，`source` 原样回灌（渲染分流据此） | opencode 源码 prompt.ts:808+ |
| `GET /find/file?query=&directory=&type=file&limit=`：返回**相对 directory 的路径字符串数组**（absolute 需客户端拼）；`type`/`dirs`/`limit` 可选 | openapi |
| `POST /session/:id/command` body 也收 `parts`（file part 数组）——斜杠命令可携带引用 | openapi 本轮复核（移动端 6R-C 同） |

## 2. 模型（renderer）

```ts
export interface FileRef {
  path: string      // 相对 worktree（展示 + source.path；目录尾随 /）
  absolute: string  // 绝对路径（拼 url）
  filename: string
  isDir: boolean
}
```

- store：`fileRefs: Map<string, FileRef[]>`——key = **sessionID（chat composer）或作用域目录（引导页 composer）**，与草稿键位同构（design-compose-draft §2）；`fileRefsFor / addFileRef（按 absolute 去重）/ removeFileRef / clearFileRefs`。纯内存不持久化（同草稿 D1）
- `fileRefToFilePart(ref)`（app-store 导出纯函数）：`{type:"file", mime:"text/plain", url:file://absolute, filename, source:{type:"file", path, text:{value:"",start:0,end:0}}}`
- 清理挂点（与草稿/视图状态同点）：`closeTab` chat 分支 + `cleanupSessionState`；目录卸载（closeProject/closeGlobalDirectory/removeWorkspace，随 guideDrafts）；`teardownConnection` 全清；**发送成功即清**（失败保留供重发，移动端 6R-A 模式）

## 3. 三入口

### 3.1 `@` 搜索浮层（chat + 引导页 composer 共用组件 `FileRefPicker`）

- 触发：textarea onChange/onKeyUp 提取光标所在 `@词`——纯函数 `atMentionQuery(text, caretIndex)`：从光标向前找最近空白，前缀 `@` 且非转义（`\@`）→ 返回 query（`@` 后子串）；无 → null
- 查询：`GET /find/file?query=<词>&directory=<作用域目录>&type=file&limit=20`（**仅文件**——`@` 场景目录歧义不可辨且价值低；目录引用走右键/拖拽）。absolute = `directory + "/" + rel`（rel 以 / 开头时直接用，DR-1）；isDir=false
- 浮层：锚 composer 上方（同 CommandHints 视觉/交互模式）：列表 + ↑↓ 移动、Enter/Tab 选中、Esc 关闭、`isComposing` 守卫；loading/空态
- 选中：**删除 `@query` 文本片段**（textarea 设值 + rAF 光标回退到该位置——受控赋值会把光标甩到末尾）+ `addFileRef`；query 为空时列出前 20（limit 内）供浏览
- 防竞态：debounce 250ms + 请求序号（晚到的响应丢弃）；搜索失败落空态（非永久 loading）
- 键盘语义：浮层打开期间 **Enter/Tab/Esc 属于浮层**——空态/加载中亦消费 Enter（防把含 `@词` 草稿误发出，想发送先 Esc）；光标移动键（无修饰）经 onKeyUp 重检测（Esc 关闭后光标移回 `@词` 内可重开）
- 浮层定位锚 = composer/`guide-composer` 的 `position: relative`（同 CommandHints 契约，缺锚会浮到视口外）

### 3.2 文件树右键「引用到会话」

- `FileContextMenu` 加项（文件/目录均可）：目标路由 = **激活 chat Tab 的 composer 优先**（sessionID 键），否则**引导页 composer**（作用域目录键）——当前激活为非 chat Tab 时引用落在引导页，用户经 Ctrl+T/关 Tab 回引导页可见 chip
- FileNode → FileRef 直映射（path/absolute/name/type）

### 3.3 文件树拖拽进输入框

- FileRow `draggable`：dragstart `setData("application/x-openbuilder-fileref", JSON.stringify(FileRef))`（自定义 MIME，与 Tab 拖拽同约定，避免文本默认插入）；drop 侧解析对 path/absolute 字段类型校验（缺字段/坏 JSON → 丢弃，不产出 file://undefined）
- composer textarea（chat + 引导页）dragover（识别自定义 MIME 才 preventDefault）+ drop 解析 → `addFileRef`；drag-over 高亮

## 4. 发送构造（守卫三处扩展，移植移动端 3R-A/6R-C/6R-D）

- `sendPrompt(sessionID, text, refs?)`：parts = `[text 非空] + refs.map(fileRefToFilePart)`；**空守卫改为 text 与 refs 全空才拒绝**（允许纯引用发送）；乐观消息携带 refs（chip 渲染）
- 斜杠命令分支（ChatView send()）：command 调用 body 同样携带 parts（server 契约 §1）；乐观插入同样带 refs
- 失败：草稿 + refs 保留重发（乐观回滚路径不变）

## 5. 渲染

- **composer 引用条**（`FileRefChips`，chat + 引导页共用）：composer 顶部一行 chip（lucide `FileText`/`Folder` 图标 + 相对 path + × 删除），横向滚动
- **user 气泡引用 chip**：消息 parts 中 `type==="file" && source?.type==="file"`（`isFileRefPart` type guard）→ chip 列表渲染于气泡内文本下方；乐观消息用 FileRef 渲染同款
- chip 点击 = `openFileTab(absolute)`：absolute 由 `session.directory + source.path` 拼（**禁止用 part.url**——二进制回灌 url 变 `data:`，移动端 4R-B）；目录（path 尾随 `/`）与 data: 不可点
- assistant/合成 part 的 file 不渲染引用 chip（仅 user 消息流内）

## 6. 不做的事

- `SymbolSource` / `ResourceSource`（引用文件内符号/MCP resource）——移动端同款取舍
- `@` 浮层目录搜索（`type=file` 固定；目录经右键/拖拽）
- 引用跨重启持久化（同草稿）；引用编辑（重排/改名，仅增删）
- 文件字节上传附件（data URL 路径，移动端 design-attachments 的独立功能，桌面未提）
- `@` 触发 picker 的 IME 交互定制（`@` 全角／半角差异交由输入习惯，仅识别半角 `@`）

## 7. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/api-types.ts` | `FilePartInput`（发送）+ `FileDisplayPart`（回灌消费 type guard 依据） |
| `src/shared/rest-client.ts` | `promptAsync` parts 类型放宽；`findFiles(query, directory)`；`sendCommand` 携带 parts |
| `src/renderer/src/store/app-store.ts` | `FileRef` + `fileRefToFilePart` + `fileRefs` Map 及读写清理；`sendPrompt` refs 参数与 parts 构造；乐观消息扩 refs |
| `src/renderer/src/components/file-ref.tsx` | 新：`FileRefChips` + `useFileRefInput`（@ 浮层 hook，返回 picker/chips/onTextChange/onKeyDown/dragProps）+ `atMentionQuery` 纯函数 + drop 处理 helper |
| `src/renderer/src/components/workspace.tsx` | composer 接线（chip 条、@ 触发、drop）；send() 守卫与 parts 扩展；user 气泡 chip 渲染 |
| `src/renderer/src/components/file-panel.tsx` | 右键菜单项 + FileRow draggable |
| `src/renderer/src/i18n/index.ts` | `fileRefToSession` / `fileRefNoMatch` 等 |
| `src/renderer/src/styles/app.css` | `.ref-chips` / `.ref-chip` / `.file-ref-picker` |
| 测试 | `atMentionQuery` 纯函数；`fileRefToFilePart`；store（增删去重/清理挂点/sendPrompt parts/纯引用守卫）；组件（chips 渲染删除、picker 键盘交互） |

## 8. 验收（对齐 spec #4）

- 三入口各添加一个文件 + 一个目录（@ 仅文件），chip 正确、× 可删
- 纯引用可发送；server 端 AI 收到文件/目录内容（Read tool 注入）
- 引用 + 文本混合发送 parts 序列正确；斜杠命令携带引用
- user 气泡（乐观 + 回灌）渲染引用 chip；文本文件 chip 点击开文件 Tab；目录/data: chip 不可点
- `npm run test` / `typecheck` / `build` 全绿
