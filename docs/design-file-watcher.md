# 文件监听：磁盘变化实时更新右栏文件树与文件 Tab — 设计文档

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
