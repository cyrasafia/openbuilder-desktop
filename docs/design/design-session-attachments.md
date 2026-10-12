# 会话附件（文件与贴图）— 设计文档

> **超限交互统一修订（2026-10-12，§2b）**：附件/引用超限时不再"拒绝即弃 + 4 秒 notice"（附件）或"无预检直发 → server 400 乐观闪退"（引用），统一为**占位 + 常驻红字 + 发送置灰**——起因为 142MB `.pkg.tar.zst` 引用发送实测（server 同步 400，错误仅左栏小图标，用户感知"消息闪一下消失且无提示"）。新增 server 20MiB `file://` 预检契约（实测 v2.0.18，`Attachment exceeds the 20971520 byte limit`）。

> **v2 迁移注记（2026-09-29，M4）**：发送端点换 `POST /api/session/:id/prompt`（200 回执驱动，files 为 v2 `{uri, name}`）；data URL 内联策略与体积上限延续。


> 对应 [spec-v0.4.md](../spec/spec-v0.4.md) #5。三入口（粘贴图片/拖拽外部文件/附件按钮）→ data URL 内联随 `prompt_async` parts 发送；输入区附件条 + 用户气泡缩略图渲染。
>
> 参考来源（按 AGENTS.md 前置约定检索）：`../openbuilder/docs/docs/design/design-attachments.md`（完整通路 + 四轮评审修复 AT-1~AT-R12 全部继承）与 `design-image-attachment-thumbnail.md`（惰性缩略图与乐观/权威统一渲染）。桌面端按 Web 平台特性重组（见 §6 平台差异）。

## 1. 契约（继承移动端实测，openapi 复核）

| 事实 | 来源 |
|---|---|
| 无独立上传端点：`FilePartInput`（type/mime/url 必填，filename 可选）与 TextPartInput 并列进 `prompt_async` parts；`url = data:<mime>;base64,…` 内联字节 | 移动端实测 + openapi |
| server 原样回传 data URL（不归一化为 http 存储）——51 会话实测全量 data: scheme | design-image-attachment-thumbnail 前提验证 |
| `ImageAttachmentConfig.max_base64_bytes` 按 **base64 体积**语义；客户端 4MB 上限对 base64 长度校验（AT-3） | openapi + 移动端 AT-3 |
| 斜杠命令 `POST /session/:id/command` body 同样收 parts（v0.3 已带引用，附件同路） | design-file-reference §1 |

## 2. 模型与通路

```ts
export interface Attachment {
  id: string          // att_<ts>_<rand>
  mime: string
  filename: string
  dataUrl: string     // data:<mime>;base64,…（发送与渲染共用——Web 平台 img 直读）
  isImage: boolean    // mime.startsWith("image/") && !svg
}
```

- **store**：`attachments: Map<refKey, Attachment[]>`——key 与 fileRefs/草稿同构（sessionID chat composer / 作用域目录引导页）；CRUD 与清理挂点同 fileRefs（发送成功清、失败保留重发、closeTab/目录卸载/teardown 清）。**只存 dataUrl 一份**（移动端 AT-6 教训：不另存全尺寸缩略图字节；预览渲染由浏览器 `<img src=dataUrl>` 异步解码）
- **管线** `src/shared/attachment-pipeline.ts`（纯逻辑 + 注入 canvas 实现供单测）：
  1. 读字节（`File.arrayBuffer()`）；mime = `file.type` || 扩展名推断（`guessMime`）|| `application/octet-stream`
  2. 图片：canvas 压缩（maxWidth/maxHeight 2048，quality 0.85）→ **base64 长度**校验 4MB：超限循环降质（85→65→45→30）→ 再超逐次宽度减半（2048→1024→512）→ 仍超接受并发送侧自然失败（`shrinkToBase64Limit`，AT-3/AT-R7）
  3. 非图片：base64 长度 > 4MB → 拒绝（`rejected` 名单，UI 提示）
  4. 输出 `{accepted: Attachment[]; rejected: {name; reason}[]}`（移动端场景验证表逐条对应）
- **发送**：`sendPrompt(sessionID, text, refs?, attachments?)`——parts 追加 `{type:"file", mime, url:dataUrl, filename}`（**无 source 字段**，与引用型 FilePart 的分野）；空守卫扩展为 text/refs/attachments 全空才拒绝（纯附件可发，移动端 3R-A）；乐观消息携带 attachments（气泡即见，spec「乐观消息附件随上屏」）；成功清 attachments（+refs），失败保留（AT-11）
- 斜杠命令 send（ChatView）：parts 同样携带附件（§1 契约）

## 2b. 超限占位（附件/引用统一，2026-10-12 修订）

原分叉行为（附件超限 = rejected + 4 秒 notice 即弃；引用超限 = 无预检直发，server 400 后乐观撤回 + 错误仅左栏状态行小图标——用户感知"消息闪一下消失且无提示"）统一为**占位拦截**：

| 项 | 语义 |
|---|---|
| 上限（引用 file://） | `MAX_FILEREF_BYTES = 20MiB`（20971520，server 实测同值——POST /prompt 对 file:// URI 同步 fstat 预检，超限 400 `Attachment exceeds the 20971520 byte limit`） |
| 上限（附件 data URL） | `MAX_BASE64_BYTES = 4MB` base64（§1 既有）+ main picker 128MB 读字节预检（§3 既有） |
| 预检通道 | 引用经 IPC `fs:statSize`（main fstat；目录/stat 失败/浏览器 shim = null 不预检，server 兜底）——renderer 无本地 stat 通道 |
| 占位模型 | `FileRef.tooLarge` / `Attachment.tooLarge`：引用在 `addFileRef` 内 fire-and-forget 预检回标（晚到标记对重加同路径 ref 仍正确）；附件超限项经 `tooLargeAttachment()` 构造（不读字节、`dataUrl: ""`）入 store |
| UI | 占位 chip 红态（`.ref-chip.too-large`）+ 常驻红字（`.form-note.attach-error`，列出文件名，与占位同寿命——删除全部占位即消失）；发送按钮置灰 + Enter 守卫 |
| 发送防御 | `sendPrompt`/`sendCommand` 过滤 tooLarge 条目（UI 已拦，兜底程序化调用）；空守卫按过滤后判定——纯占位 + 无文本 = `empty`，不发零宽空格裸消息 |
| 删除恢复 | `removeFileRef`/`removeAttachment` 既有路径，UI 重算置灰条件自然恢复 |

**判定注记**：引用预检是 fire-and-forget 异步——占位标记落地前（约一次 IPC 往返）chip 短暂呈正常态；此窗口内点发送仍会打到 server 400（既有 catch 撤回路径），可接受（窗口毫秒级，且超限引用是少数场景）。

**上游追踪（2026-10-12 核实）**：上游 `anomalyco/opencode` 分支 `attachment-path-delivery`（commit `30fb0dc3fb`，PR #49682/#49717）拟把「file:// 超 20MiB 拒绝」改为「admit 为路径引用」（cap 收窄到只拒 data: URL）。该提交不在 v2.0.18..v2.0.24 任何 tag 中——当前 pin（2.0.18）契约确如本节所记，代码与 pin 一致。若上游合入，本端 20MiB 硬预检会拦住 server 将接受的发送，需随 pin 升级同步放宽（预检常量与 server cap 的对齐是升级检查项）。

## 3. 三入口

| 入口 | 实现 | 说明 |
|---|---|---|
| 粘贴 | composer textarea `onPaste`：`clipboardData.files.length > 0` 时 preventDefault + resolveFiles | **文本粘贴不变**（无 files 不拦截）；clipboard 非图片文件（文件管理器复制）spec 范围外——`files` 里有就走（自然支持，无需特判） |
| 拖拽外部文件 | composer dragProps 扩展：`types.includes("Files")` → preventDefault + drop 取 `dataTransfer.files` | **工作区文件树拖入仍是 source 引用**（FILEREF_MIME 自定义路径不动，spec 明确）；两种 MIME 互斥不冲突（types 判定顺序：FILEREF_MIME 优先） |
| 附件按钮 | 输入框内（`.composer-input` 左侧）`Plus` 按钮 → IPC `dialog:openFiles`（多选） | 对齐 openbuilder compose `prefixIcon`（Icons.add）形态（2026-09-05 修订：原 composer 工具区 `Paperclip` 按钮）；main `dialog.showOpenDialog({properties:["openFile","multiSelections"]})`；preload/shim 同模式 |

## 4. 展示

- **composer 附件条**（chat + 引导页共用 `AttachmentChips`，紧随引用条）：图片 = 48px 缩略图（`<img src=dataUrl>` 圆角 + hover 删除钮）；非图片 = 引用 chip 同款（图标 + 文件名 + ×）；横向滚动；超限拒绝项经 `connectionError` 同通道提示（无 toast 基建，同项目惯例）
- **用户气泡 file part 渲染分流**（`userFileChipItems` 消费侧扩展）：`source.type==="file"` → 引用 chip（不变）；无 source 且 `url` 为 `data:` 且可显示图片（image/* 除 svg）→ **缩略图 + 点击放大**（最大高 220 圆角，`loading="lazy"` + `decoding="async"`）；无 source 非图片 → 文件名 chip（既有）
- **点击放大**：全屏遮罩 dialog（img 最大化 contain + Esc/点击关闭）——简单模态，无缩放（桌面可后续）
- **乐观消息附件**：optimistic 消息渲染直接用 Attachment（dataUrl img）——乐观/权威渲染形态一致（移动端 thumbnail 文档的核心结论：分叉点用 mime 而非「有无缩略图数据」）
- **历史会话惰性缩略图**：权威消息的 data URL 交给 `<img>` 的原生异步解码（`decoding="async"`、视口外不解码 `loading="lazy"`）——Web 平台无 Flutter 的 isolate 问题（移动端踩坑在桌面由浏览器内核天然化解，见 §6）

## 5. 实现落点

| 文件 | 变更 |
|---|---|
| `src/shared/attachment-pipeline.ts` | 新：Attachment 模型 + resolveFiles 管线 + guessMime/toDataUrl/base64Len/shrink 纯函数 + CanvasImageOps 注入面 |
| `src/renderer/src/store/app-store.ts` | attachments Map + CRUD/清理；sendPrompt 扩参；乐观消息扩 attachments；斜杠命令 send 扩 |
| `src/renderer/src/components/attachments.tsx` | 新：AttachmentChips（composer 条）+ AttachmentThumb（气泡缩略图 + 点击放大）+ useAttachmentDrop（Files MIME drop）+ pickerButton（Plus 按钮）|
| `src/renderer/src/components/file-ref.tsx` | userFileChipItems 输出扩附件型条目（image 标记）；dragProps 接 Files 分支 |
| `src/renderer/src/components/workspace.tsx` | composer 接线（onPaste/附件条）；textarea 包入 `.composer-input`（+ 按钮居内，`pickerButton` 注入框内）；user 气泡渲染分流 |
| `src/main/ipc.ts` + preload + shim + DesktopApi | `dialog:openFiles` |
| i18n / app.css | 文案与样式（token 复用） |

## 6. 平台差异（相对移动端设计）

- **渲染解码**：Flutter 需 isolate 解 base64 + cacheWidth 控位图（AT-4/AT-R2/thumbnail 文档）——Web `<img src=dataUrl>` 由浏览器异步解码、`decoding="async"`+`loading="lazy"` 即惰性；无需 ImageDataCache 对等物（浏览器内部缓存 + 组件 unmount 释放）
- **压缩**：flutter_image_compress → canvas（createImageBitmap + drawImage + toBlob(q)）；createImageBitmap 失败（HEIC 等）→ 图片按非图片处理透传原字节（超 4MB 拒绝）
- **相机/相册/SAF 权限面**：不存在（系统文件选择器/剪贴板/拖拽）
- **大附件超时**：fetch 无 dio sendTimeout 问题；`promptAsync` 默认 15s 超时——**附件 totalLen > 1MB base64 时放宽 120s**（rest-client promptAsync 加可选 timeoutMs，AT-12 对应）

## 7. 测试

- pipeline 纯函数：guessMime（扩展名/类型缺失）、toDataUrl、base64Len、shrink 循环计划（注入 bitmap/canvas 桩：尺寸超限→降质→缩宽）、非图片超限拒绝、resolveFiles 聚合
- store：attachments CRUD 去重键位、sendPrompt parts 序列（text+ref+attachment 混排）、纯附件守卫、成功清/失败留、乐观携带；引用体积预检回标（§2b：超限标/限内与 null 不标/目录不预检/删除恢复）、sendPrompt 过滤 tooLarge + 纯占位 empty 守卫（§2b）
- 组件：AttachmentChips 渲染删除、气泡缩略图/文件 chip 分流、点击放大开关
- E2E（人工/CDP 可选）：粘贴截图 → 发送 → 用户气泡缩略图 → AI 读到内容回复

## 8. 范围外（spec + 移动端同款）

- SymbolSource/ResourceSource 引用；clipboard 文件管理器复制粘贴的特化；附件转工作区引用/落盘
- SVG 缩略图渲染（按文件 chip 显示）；GIF 动图（img 原生支持首帧即静动）；多图九宫格
- 附件草稿跨重启持久化（同引用，纯内存）

## 9. 联调实测记录（2026-09-05，live server 1.18.20 @15120）

- **协议**：`prompt_async` parts 携带 `{type:"file", mime:"image/png", url:data:…, filename}` 返回 204；user 消息回灌 file part 原样保留 data: URL、无 source 字段（与设计 §4 分流假设一致）
- **AI 读图**：64×64 纯红 PNG 附件 + "What solid color fills this image?" → AI 回复 "Red"（1×1 图被 provider 以「边长 <10px」拒绝——侧面证明图片真实到达模型）
- **大附件超时**：`promptAsync` data URL 总长 >1MB → 120s（store 层不感知，见 rest-client）
- 测试：管线 9 用例（mime 推断/plan 循环/超限拒绝/解码失败透传/聚合）+ 组件 6 用例（chips/缩略图放大/分流/粘贴拦截）+ store 4 用例（CRUD/混排 parts/纯附件/失败保留）
