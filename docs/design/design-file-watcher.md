# 文件监听：磁盘变化实时更新右栏文件树与文件 Tab — 设计文档

> **v2 迁移注记（2026-09-29，M6c 盘点）**：2.0.18 事件全集无 `file.watcher.updated`、无 watch 端点——文件监听自 v2 迁移（M3）起静默失效；重开 Tab/切作用域/重连对账重拉兜底，链路代码保留待上游恢复（spec-v0.5 功能降级表 #3）。
>
> **v2 复活（2026-11-25）**：server v2.2.0 起提供单文件监听端点 `POST /api/experimental/fs/watch`，配合 `filesystem.changed` 事件，**已打开文件 Tab 的内容自动刷新**已恢复，见 §7。文件树的新增/删除刷新仍不可得（无目录监听）。§2、§3 保留 v1 原设计作语义来源，现行事件源与注册生命周期以 §7 为准。


> 目标：文件在磁盘上被新增/修改/删除（agent 工具写盘或外部编辑）时，右栏文件树实时增删刷新，已打开的文件 Tab 内容实时重拉刷新。
>
> 参考来源（按 AGENTS.md 约定先行检索）：
> - openbuilder 移动端：无文件树/文件内容 Tab 的实时失效先例（文件浏览是会话内附件消费，`design-file-view.md`），无可借鉴。
> - 官方 `../opencode` 桌面端（packages/app）：`context/file/watcher.ts` 的 `invalidateFromWatcher` 是同功能实证实现——只消费 `file.watcher.updated` 事件，内容失效（已打开/已缓存文件重拉）+ 树失效（已加载目录重列）两条路径，`.git/` 路径跳过。本设计按其语义适配本项目数据结构。

## 1. 问题

文件树与文件 Tab 内容都是拉取式快照：打开后磁盘再变化（典型场景：会话进行中 agent 写盘；外部编辑器改动；git 切换分支）不刷新——树里新文件不出现、删除的文件残留，文件 Tab 显示过期内容，用户须手动切走切回才重拉。

## 2. 事件源（D-1：只消费 `file.watcher.updated`）

server 侧 @parcel/watcher 监听项目目录，SSE 广播 `file.watcher.updated`。实测契约（本机 server `/global/event` 抓包）：

```
{"directory":"<location 目录>","project":"<项目 id>",
 "payload":{"id":"evt_…","type":"file.watcher.updated",
            "properties":{"file":"<绝对路径>","event":"add"|"change"|"unlink"}}}
```

- `file` 为**绝对路径**（@parcel/watcher 原样上报）。
- 信封 `directory` = 该文件所属 location 目录（项目根或 worktree），过既有事件闸门（`isOpenedDirectory`）——关闭项目/未打开目录的事件到不了处理逻辑。
- 两类来源：项目根 watcher（ignore node_modules/.git 等）+ git 目录 watcher（index/refs 变化，**`.git/**` 事件会到达客户端**，见 §3 过滤）。

不消费 `file.edited`（agent write/edit 工具发布）：磁盘监听已覆盖全部落盘变化（含 agent 自己的写），双通道只会造成重复触发与去抖交织；官方桌面端同样只用 `file.watcher.updated`。

## 3. 处理逻辑

`handleEvent` 增 `file.watcher.updated` 分支，统一入口 `onFileWatcherEvent(directory, file, kind)`：

1. **防御**：`file` 非绝对路径丢弃；`kind` 不在三值内丢弃。
2. **相对化 + `.git` 过滤**：`file` 必须位于事件信封目录之内（`file === directory` 视为 `rel=""`），否则丢弃——实测 location 之外的帧只有 git 元数据目录（服务端把 git 目录监听挂到 worktree location 上，index/refs 帧的信封目录是 worktree、file 却在主仓 `.git` 内），与内容/树浏览无关。随后按官方 app 同规则丢弃 `rel === ".git"` 或 `rel` 以 `.git/` 开头。**不得按绝对路径组件过滤**：worktree 目录可能物理位于项目 `.git/` 之下（测试夹具/旧约定 `.git/opencode-worktrees/*`），绝对路径含 `/.git/` 会误杀 worktree 内全部事件；相对化后 worktree 内文件的 `rel` 不以 `.git/` 开头，天然免疫。
3. **内容失效**（三值都触发）：有已打开文件 Tab（`file:${file}`）才重拉（D-3）。
4. **树失效**（仅当事件信封目录 = 当前作用域目录，树只承载当前作用域；worktree 物理上可能在项目根内，归属判定只认信封目录，不用路径前缀）：
   - `add`/`unlink`：父目录已加载（`fileTreeNodes.has(父键)`）→ 重列父目录；
   - `change`：该路径自身是已加载目录节点（`fileTreeNodes.has(rel+"/")`）→ 重列自身（文件内容变化不改树形，不触发父目录重列）。

### 3.1 内容重拉（D-3/D-4）

- 目标 = 已打开文件 Tab。无 Tab 的缓存条目不重拉：缓存不可见，Tab 重开/激活本就重拉（`openFileTab` 新建分支与 FileView 激活 effect），不做无用 fetch。
- REST `directory` 参数取 **Tab 的 `directory`**（打开时作用域），不用当前 `scopeQuery`——Tab 可跨作用域混排，事件到达时当前作用域可能已不是该 Tab 的。
- **每路径去抖 300ms**：burst（agent 连续写、格式化回写）合并为一次 fetch。
- **singleflight + dirty 再武装**：fetch 在途时新事件只置 dirty 不并发；在途完成后 dirty 则再排一次去抖——保证 fetch 期间落地的后续修改不丢（"实时"的正确性底线；官方 app 只有 inflight 去重，此处收紧）。
- 落地守卫：client 身份（跨 teardown 丢弃）+ Tab 仍存在（在途期间可能已关闭）。`unlink` 走同一重拉路径：`/file/content` 报错 → 缓存落 error 条目 → FileView 显示错误态（与官方 app 对删除文件 `loadFile` 失败同语义；不自动关 Tab——文件可能被恢复）。

### 3.2 树刷新

复用 `loadFileNodes(dirPath)`（自带作用域闸门：落地时作用域已切走则丢弃）。同样每目录键去抖 300ms（git checkout 一类整目录波动合并）。已加载判定即 `fileTreeNodes` 键存在——未展开/未加载的目录不触发 fetch（惰性树语义不变）。删除目录的孤儿子孙条目不主动清理（随 `resetFileTree` 统一回收，与现有惰性树生命周期一致）。

**挂起定时器随树重置作废**：`loadFileNodes` 的闸门只挡"在途期间作用域切走"，不挡"定时器落地前切走"——后者会让旧作用域的树刷新打进新作用域。因此 `resetFileTree`（切作用域/开项目/拆连接）同时清空挂起的树刷新定时器。内容重拉定时器**不**在此清：Tab 跨作用域存活，切走后重拉仍有意义（Tab 存在性守卫兜底）。

### 3.3 清理

`teardownConnection` 清空两组去抖定时器（连接拆除后不得再有重拉/刷新落地）。

## 4. 渲染层

零改动：`FileView` 响应式读 `store.fileContents`（CodeView 已有 content prop → doc 整体替换同步；markdown/HTML 预览随缓存重渲染）；`FilePanel` 响应式读 `fileTreeNodes`。store emit 即全链路刷新。

## 5. 不做的事

| 项 | 原因 |
|---|---|
| `file.edited` 双通道 | 见 §2，磁盘监听已覆盖 |
| 树节点"已修改"角标 | 本需求未提；树刷新只负责结构增删 |
| diff Tab 随文件变化实时重拉 | 独立关注点（.git 事件恰是其信号源），后续按需另做 |
| 未打开 Tab 的缓存预失效 | 不可见且重开必重拉，纯浪费 |
| 编辑器内容冲突处理（外部改 + 本地未保存） | 文件视图只读，无冲突面 |

## 6. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `handleEvent` 增 `file.watcher.updated` 分支；`onFileWatcherEvent` + 内容重拉（去抖/singleflight/dirty）+ 树刷新（去抖）；`teardownConnection` 清理 |
| `src/shared/api-types.ts` | `OpencodeEvent` 联合增 `file.watcher.updated` 成员 |
| `src/renderer/src/store/app-store.test.ts` | 事件直驱测试（内容重拉/树刷新/过滤/守卫） |

## 7. v2 复活：已打开文件的内容自动刷新（2026-11-25）

> 触发：server 升至 2.4.1 后的契约审计（ref-pin-bump-2.4.1）确认单文件监听端点可用。范围 = §3.1 的内容失效；§3.2 树失效只剩一条可达路径——被监听文件删除时重列其父目录。
> 参考来源（AGENTS.md 约定）：移动端无同类功能（文件浏览是会话内附件消费，design-file-view）。两条经验吸收进本设计：openbuilder design-file-cache §3.1——SSE 事件不保证送达，不能做唯一正确性来源；design-frame-drop JANK-6/10——未消费的事件不得落到全局刷新。官方 App v2.4.1 的 `workspaces/files/watcher.ts`（`invalidateFromWatcher`）消费同一事件，语义与 §3 相同。

### 7.1 契约事实（活体 2026-11-25，server 2.4.1）

| 项 | 事实 |
|---|---|
| 注册 | `POST /api/experimental/fs/watch?location[directory]=<目录>`，body `{path}`，path 是相对 location 的**文件**路径。204 无返回体。重复注册只**延长过期**，不重启监听（见「监听后端」） |
| 取消 | `DELETE`，同路径同 body。204。监听记录按 (location, 文件) 全局唯一、无引用计数——任何客户端的 DELETE 都会取消该监听 |
| 事件 | 全局 SSE 流上的 `filesystem.changed`：`{"type":"filesystem.changed","location":{"directory":"…"},"data":{"file":"<绝对路径>","event":"change"` 或 `"unlink"}}`。本机实测延迟 2–3 ms |
| 限额 | 每个 location 最多 256 个文件，超出时淘汰最早过期的一个（不报错）；24 小时过期（源码 `core/src/filesystem/file-watch.ts`） |
| 错误 | 404 `FileNotFoundError`（文件不存在，或 path 是目录——目录不能监听）；404 `LocationNotFoundError`（目录已死）；503 `ServiceUnavailableError`（server 关闭了文件监听）；400 `InvalidRequestError` |
| 旧 server | 端点自 v2.2.0 提供（ref-pin-bump-2.2.0 §2）。未知路由返回 **404 且无响应体**，已知路由的错误体都带 `_tag`——两者可区分。验证方法：对不存在的路由发 POST（本机 2.4.1 实测）；旧 server 上本端点即属未知路由，属推断，未在旧 server 活体 |
| 关闭开关 | `OPENCODE_FILEWATCHER_DISABLE` / `OPENCODE_DISABLE_FILEWATCHER`（`packages/cli/src/server-process.ts`）→ `watchFile` 返回 503 |
| 稳定性 | experimental 端点，上游声明「may change without compatibility guarantees」 |
| 监听后端 | server 对单文件实际监听**父目录**：`fs.watch(dirname, {recursive:false})` + 文件名过滤（`core/src/filesystem/watcher.ts` nativeLayer）。本机（Linux，server 2.4.1）实测：截断写、rename 覆盖、`sed -i` 都收到 `change`；**同目录内**删除后重建仍能收到事件；**父目录删除后重建，监听死亡**（删除时报 `unlink`，此后无事件），重新 POST 只续期不复活，`DELETE` + `POST` 才恢复。其他平台与运行时未实测 |

运行时的行为不可外推：桌面版 bun 1.3.14 的 `fs.watch(dir)` 在 rename 覆盖时只报临时文件名（按文件名过滤即丢事件），本机 server 则报目标文件。判定监听行为必须以**运行中的 server** 为准。

`filesystem.changed` 另有一个来源：server 每个 location 监听 `.git/HEAD`（切分支检测）。这些帧被 §3 的「相对化 + `.git` 过滤」丢弃。监听记录是全 server 共享的，其他客户端注册的监听也发同一事件——本端只消费命中已打开 file Tab 的帧。

### 7.2 事件源（修订 D-1）

只消费 `filesystem.changed`。v1 的 `file.watcher.updated` 是遗留名，v2 server 从不发布，其分支与类型成员删除。处理函数沿用 §3 的 `onFileWatcherEvent`：载荷从 `data.file` / `data.event` 读，形状与 v1 相同。

### 7.3 监听注册（新）

**注册时机 = 文件 Tab 内容成功加载之后**（`loadFileContent` 与监听重拉两条路径的成功点）。条件全部成立才注册：

1. 存在同路径的 file Tab，且加载所用目录等于 Tab 归属目录。markdown 预览的相对图片也走 `loadFileContent`，但没有 file Tab——不注册（沿用「监听仅覆盖打开的 file Tab」）。
2. 内容可刷新：文本看内容嗅探结果，图片 / PDF 按 **Tab 路径扩展名**判定（`@shared/file-kind` 的 `isImagePath` / `isPdfPath`，与 FileView 的渲染分发同源——server 的 MIME 头会误判）。不可预览的二进制只有占位，刷新没有可见变化，不占名额。
3. 文件位于 Tab 归属目录之内（与 server 的 read confinement 一致；之外的读取本就失败），且不在 `.git/` 下——`.git` 内的事件本就会被 §3 的过滤丢弃，注册无意义。
4. 本次连接未判定为「不支持」（见 7.4）。

**取消时机**：关闭 file Tab（`closeTab`，best-effort，失败忽略），或成功重拉发现文本已变成不可预览的二进制。其余移除路径不取消：`teardownConnection` 只清本地记录、不发请求，由 server 的 24 小时过期回收。

**注册请求的落地守卫**：在途期间关 Tab / 改归属 / 连接换代——注册不落记录；server 侧已建立的监听立即取消，不留到过期。同一 Tab 的注册、重启、取消按 client 串行执行，同目标请求合并；每次操作推进代次，旧回执不得覆盖新目录或新 Tab 实体的状态。迟到的 DELETE 因此不会取消后续 POST，慢请求也不会被对账重复发起。

**续期 = 重启监听**：注册记录带时刻。记录满 12 小时后，由 60 秒对账定时器搭车**先 DELETE 再 POST**。不能只发 POST：server 对已存在的记录只延长过期、不重启监听，而监听会因父目录删除后重建而死亡（§7.1 活体实证）。两步之间的极短窗口可能漏事件，由激活即重拉兜底。

**从失效态恢复即重启**：内容加载成功且此前缓存是 error 条目（文件曾被删、目录曾死）时，立即重启监听，不等续期窗口——监听可能已随父目录重建死亡。

**注册失败待重试**：网络错误、400 等失败记为待重试（时刻置 0），对账每分钟重试。前台常驻的 Tab 没有「激活即重拉」这条恢复路径。文件不存在与目录已死会清除既有待重试记录（无可监听对象，下次加载成功再注册）。

**Tab 归属目录变更**（`openFileTab` 复用已开 Tab 时改写 directory）：旧目录的监听取消，新目录在下次加载成功后注册。

### 7.4 能力探测（新）

不发探测请求。首次注册的响应即探测结果，按错误族分三路：

| 响应 | 含义 | 处置 |
|---|---|---|
| 404 且无 `_tag` | server 低于 v2.2.0，无此路由 | 本次连接标记不支持，不再尝试；重连后重置 |
| 503 且带 `ServiceUnavailableError` | server 关闭了文件监听 | 同上 |
| 404 `FileNotFoundError` / `LocationNotFoundError` | 无可监听对象（文件不存在 / 目录已死） | 不改能力态，不留待重试记录；下次加载成功再注册 |
| 400、网络错误、无 `_tag` 的 503（代理或网关造的） | 个别文件或瞬时问题 | 不改能力态；记为待重试，对账每分钟重试（7.3） |

注册请求带 `location[directory]`，经 `withLocation` 包装：删除窗口的挂起闸门与死目录确证回执照常生效（design-worktree-sync §3.5/§3.6）。

### 7.5 处理链路适配

- **事件分支不发 `emit`**：分支内没有同步的状态变化（重拉经去抖定时器异步落地，落地时自行 emit）；没有命中已打开文件的事件直接返回。`.git/HEAD` 帧因此是纯空转。
- **PDF 重载**：PDF 文件 Tab 由 Chromium PDFium 直读 `file://`，不渲染 `fileContents`，内容重拉对它无效。store 在监听重拉成功后给该文件的「重拉序号」加一，`PdfFrameView` 见序号前进即重新导航。已导航到的序号跨挂载保留：后台期间的重拉在切回 Tab 时补导航。页码回到首页是接受的代价。
- **PDF 不受「激活即重拉」覆盖**：切回 Tab 复用既有视图、不重新导航（保留页码，design-pdf-preview）。所以监听丢失或静默停用时，PDF 切回仍显示旧内容——接受的例外（改动前也不刷新），恢复靠监听重拉或重开 Tab。D-10 的兜底对 PDF 不成立。
- **`unlink`**：沿用 §3.1——读取失败落 error 条目，不自动关 Tab。**同目录内**删除后重建，server 仍报事件，重拉成功即自愈；**父目录**删除后重建则监听死亡，由「从失效态恢复即重启」接管（7.3）。

### 7.6 场景验证

| 场景 | 预期 |
|---|---|
| 打开文本文件，agent 改写它 | 300 ms 去抖后 Tab 显示新内容；后台 Tab 的缓存同步更新，切回即新 |
| 连续多次写盘 | 合并为一次重拉（§3.1 去抖 + singleflight） |
| 原子保存（rename 覆盖）、`sed -i` | 正常收到 change（本机 server 2.4.1 实测；其他运行时未实测，见 7.1） |
| 打开的图片被重新生成 | 预览刷新（按扩展名判定，不受 server MIME 误判影响） |
| 打开的 PDF 被重新生成 | 视图重新导航；若在后台，切回时导航 |
| 文件被删除 | Tab 呈错误态；父目录若已展开则重列。同目录内重建 → 重拉成功即自愈；父目录删除后重建 → 监听死亡，恢复重拉成功时重启监听 |
| `.git/` 下的文件 | 不注册监听（事件本就被过滤，注册无意义） |
| 注册遇瞬时失败（网络错误） | 记为待重试，对账每分钟重试；前台常驻 Tab 也能恢复 |
| 关闭 Tab | 取消监听；此后该文件的变化不再触发重拉。注册在途时关 Tab → 落地时取消 server 侧监听 |
| 文本重拉后变成不可预览二进制 | 取消既有监听，不再占 server 名额 |
| 注册慢请求跨越对账周期 / Tab 归属变更 | 同 Tab 操作按 client 串行、同目标合并；旧回执不覆盖新目录或新 Tab 实体 |
| server 低于 v2.2.0，或关闭了文件监听 | 首次注册后静默停用；激活即重拉照旧（PDF 例外，见 7.5） |
| 断线重连 | Tab 重建时重拉内容并重新注册；断连窗口内的修改由这次重拉覆盖 |
| 删除 worktree 时该目录有打开的文件 Tab | Tab 随目录卸载关闭；取消请求被删除窗口闸门拒绝，被吸收 |
| `.git/HEAD` 变化（切分支） | 事件被过滤，无任何动作，也不触发 emit |
| Tab 连开超过 24 小时 | 满 12 小时重启监听（DELETE + POST），不中断 |

### 7.7 关键设计决策

- **D-5 注册挂在内容加载之后，而非 Tab 创建时**：此时才知道内容类型（7.3 第 2 条），也天然排除非 Tab 的图片加载；恢复的 Tab 在重建时预拉内容，同样走到这里。图片 / PDF 的判定按扩展名，与渲染分发共用 `@shared/file-kind`（store 不依赖 components）。
- **D-6 能力探测零额外请求**：注册本身就是探测，错误族足以区分「不支持」与「个别失败」。503 须带 `ServiceUnavailableError` 才算 server 关闭——代理与网关也会造 503。
- **D-7 续期搭对账定时器，且是重启**：不新增定时器；满窗口先 DELETE 再 POST，因为 server 只延长过期、不重启监听。同 Tab 的注册、重启、取消串行并带代次守卫，避免慢回执与迟到 DELETE 破坏新状态。
- **D-8 不在每次事件后重新注册**：活体证实本机 server 在 rename 覆盖与同目录内删除重建后监听仍然有效；每次事件后重发 POST 只增加请求，不增加正确性。**父目录删除后重建是例外**——监听死亡且 POST 不复活，由「从失效态恢复即重启」与满窗口重启覆盖。
- **D-9 事件分支不 emit**：吸收移动端 JANK-6/10 的教训。
- **D-10 事件不是唯一正确性来源**：激活即重拉是兜底。断连窗口、监听丢失、平台差异都由它覆盖（移动端 design-file-cache §3.1 的教训）。**PDF 例外**：切回复用视图不重新导航，见 7.5。

### 7.8 不做的事

| 项 | 原因 |
|---|---|
| 文件树随新增/删除自动刷新 | server 无目录监听；`fs/watch` 对目录返回 404。兜底 = 工具事件触发的树刷新（待评估）或手动刷新 |
| markdown 内相对图片跟随监听 | 维持 design-markdown-preview 的既定取舍 |
| browser Tab 里的 HTML | 走 `file://`，不属 file Tab |
| 不可预览的二进制文件 | 刷新没有可见变化 |
| 每次事件后重新注册监听 | 见 D-8 |
| 删除后重建在其他平台的自愈 | 未实测；激活即重拉兜底（PDF 例外，见 7.5） |

### 7.9 涉及文件

| 文件 | 变更 |
|---|---|
| `src/shared/rest-client.ts` | `watchFile` / `unwatchFile`（`withLocation` 包装，204） |
| `src/shared/api-types.ts` | `OpencodeEvent` 的 `file.watcher.updated` 成员换成 `filesystem.changed` |
| `src/shared/file-kind.ts`（新） | 扩展名判定单一来源：`isImagePath` / `IMAGE_MIME_BY_EXT`（自 markdown-image.ts 迁入）+ `isPdfPath`（自 workspace.tsx 迁入） |
| `src/renderer/src/components/markdown-image.ts`、`workspace.tsx` | 改从 `@shared/file-kind` 取判定；markdown-image re-export 维持既有导入面 |
| `src/renderer/src/store/app-store.ts` | `handleEvent` 分支改名；`armFileWatch` / `requestFileWatch` / `restartFileWatch` / `dropFileWatch` / `rearmFileWatches`；能力态；重拉序号；`closeTab`、`teardownConnection` 挂点 |
| `src/renderer/src/components/pdf-frame-view.tsx` | 重拉序号前进 → 重新导航 |
| `src/renderer/src/store/app-store.test.ts`、`src/shared/rest-client.test.ts`、`src/renderer/src/components/pdf-frame-view.test.tsx` | 注册 / 取消 / 重启续期 / 待重试 / 失效恢复 / 能力态 / 落地守卫 / PDF 重载 / 事件分支 / 删除窗口闸门 |
