# 文件内容流式加载（design-file-load-streaming）

日期：2026-10-12。状态：已实施。

## 1. 问题

打开大二进制文件（案例：`release/arch/*.pkg.tar.zst`，142,257,177 字节）整个界面卡住数秒到更久。根因链：

1. `RestClient.readFileContent`（v2 `/api/fs/read`）对任意大小文件整包
   `arrayBuffer()` 后，在**渲染主线程同步**执行分块 `String.fromCharCode`
   拼接 + 整串 `btoa`。实测（同 V8 node）142MB：拼接 ~3.2s + btoa ~75ms，
   产出 181MiB base64 字符串。
2. 首开双拉：`openFileTab` 与 FileView 挂载 effect 各调一次
   `loadFileContent`，无 singleflight → 连续两轮全款阻塞（~6.5s+）。
3. **产出无消费**：非图片二进制最终只渲染 `binaryUnsupported` 占位
   （workspace.tsx 分支），base64 的唯一消费者是图片预览 `imageSrcFor`。
   142MB 下载 + 转换全部白费，且 181MiB 字符串随 `fileContents` 缓存驻留。
4. 切 Tab 重挂载（仅激活 Tab 挂载 FileView）「激活即重拉」每次重复付费。

## 2. 方案

三层：**嗅探即止**（二进制）、**增量转换**（图片/文本）、**进度反馈**（UI）。

### 2.1 流式消费（rest-client.readFileContent）

`res.body.getReader()` 按 chunk 消费（替代整包 arrayBuffer）：

- **前 8K 攒齐做 NUL 嗅探**（与原 `subarray(0, 8192)` 同口径）；`image/*`
  mime（svg 例外）仍由响应头预判二进制，不待嗅探。
- **非图片二进制：即刻 `reader.cancel()`**，返回
  `{type:"binary", content:"", encoding:"base64", mimeType}`——余量不下载、
  不做 base64。FileContentData 契约不变（content 本就无消费者）。
- **图片**：chunk 增量拼 binary string（转换成本摊进下载等待），完结
  `btoa`（~75ms/142MB 量级，可接受；图片鲜有此量级）。
- **文本**：`TextDecoder` stream 模式增量解码（多字节序列跨 chunk 安全），
  完结 `decoder.decode()` flush。
- 每 chunk 上报 `onProgress(received, total)`；total = Content-Length
  （chunked 响应缺省 undefined）。
- 读取中途失败（断网/超时中止）与旧路径同契约：`classifyFetchError` 包
  ApiError。`timeoutMs: 30000` 语义不变（覆盖整个 body 读取）。
- **兜底**：`res.body` 缺失（非流式环境）回退整包缓冲路径
  （`readFileContentBuffered`），行为对齐（非图片二进制同样不产 base64）。

效果：案例文件首开 = 读 ~64KB + cancel，主线程零长阻塞；双拉经
singleflight 合并（§2.2）后仅一次。

### 2.2 store：singleflight + 在途条目（app-store）

- `loadFileContent` 按 absolutePath singleflight（`fileLoadInflight`）——
  消掉首开双拉。落地守卫对齐 house style：client 换代（重连/teardown）
  丢弃，不入缓存。
- 在途落 `{content:"", loading:true}` 条目；`onFileLoadProgress` 100ms 节流
  更新 `progress:{received,total?}` 并 emit（App 层 rAF 合帧外再削一层）。
  完成后条目替换为 `fileContentEntry(fc)`（形状同旧）。
- `ensureFileImage` 委托 `loadFileContent`（同缓存/singleflight/进度语义），
  原 `fileImageInflight` 退役。error 条目不短路的重试语义保留。
- `doFileReload`（file watch 重拉）不动：2 参调用、旧内容保持显示直到
  新内容落地（重拉期间无 loading 条目，进度回调对非 loading 条目 no-op）。

### 2.3 FileView：加载态分支 + 进度条（workspace/app.css）

- 分支链**首位**判定 `cached?.loading`——空 content 的在途条目不得进入
  图片（空 data URL 破图）/PDF（binary 闸门）/文本分支。
- 进度 UI：`t.loading` 文案 + `.file-progress` 条（total 已知时，
  width = received/total）+ 字节数（`formatBytes`，KiB/MiB/GiB 一位小数）；
  无 total 只报已收字节。样式收编 app.css `.file-state.file-loading` 区块。
- 在态门控同步收紧（loading 条目视同未落地）：`revealLine` 消费、
  `mdPreviewLive`/`codeViewLive` find 注册、滚动恢复 effect——均在
  `!cached.loading` 下才生效。锚定行/滚动位不因加载起点被提前消费。
- `MarkdownImage`：loading 条目维持 pending 占位（空 content 不产 data URL）。

## 3. 语义与不变量

- **激活即重拉保留**：切 Tab 重挂载仍重 fetch（缓存仅作首帧显示）。二进制
  重拉成本 ≈ 8K 读取 + cancel，可忽略；文本/图片重拉有进度反馈。
- **FileContentData 契约不变**：binary content 语义收窄为「仅图片预览有
  值」，非图片二进制恒空串（原本就无消费者，纯省成本）。
- 文本/二进制判定不变：NUL 嗅探（前 8K）为主 + image/* mime 直判（svg
  例外）。`<8K` 文件在流完结时对整包嗅探，与旧口径一致。
- 大文本文件加载不再阻塞，但 CodeMirror 大文档渲染成本不变（另一话题，
  见 §5）。

## 4. 测试

- rest-client：非图片二进制 cancel + 空 content；图片分 chunk base64 +
  进度；文本超 8K 早判 + 多字节跨 chunk 解码。既有 47 例全绿。
- app-store：singleflight 双调合并 + 完成解除；进度节流（100ms 窗口）；
  error 落地 + ensureFileImage 重试。既有断言随第三参（onProgress）修订两处。
- file-view：loading 条目渲染进度条/字节数、不进内容分支；无 total 降级；
  formatBytes 阶梯。

## 5. 遗留（todo 候选）

- 大文本文件的 CodeMirror 渲染上限/虚拟化：加载已不阻塞，但 100MB+ 文本
  的 CM doc 构建与高亮仍是重活。可参考 `../opencode` session-ui 的分段渲染。
- 图片超上限（如 >64MB）时可考虑拒绝 data URL 改占位提示（当前照转）。
- `timeoutMs: 30000` 对超大文件慢速链路可能中途 abort——按需改分级超时。
