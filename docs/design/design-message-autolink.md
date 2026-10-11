# 会话消息文件路径自动链接 — 设计文档

> 状态：已实现（2026-10-11），全量测试通过；含评审修订三轮（插件次序/click 归属校验/ME-3 表述，见 §2.8/§2.5/§3 修订标注）；实现期联调实测契约事实见 §2.5a（rehype-sanitize 白名单 / hast 层 target 注入 / 外层 memo 上游特性）
> 参考来源：**openbuilder `docs/design/design-message-autolink.md`**（移动端 v2 文件路径扩展 + 六轮评审 + MF-1/MF-2 线上缺陷修复，识别规则逐条移植）；本仓 `design-markdown-preview.md` §2.9（CJK 标点先例，同为 ASCII 为中心语法规则的坑位家族）
> 移动端姊妹实现：`openbuilder/lib/features/conversation/message_autolink.dart`（识别/编码/解码/归属校验的规则源）+ `conversation_screen.dart` `_markdownPart`/`_onMdLink`/`_openLinkedFile`（接入形态——桌面不照搬，见 §2.1）

## 1. 问题

AI 回复高频出现**项目内文件路径**（`src/foo/bar.ts`、`/abs/worktree/lib/main.dart:42`），渲染为纯文本不可点击。用户想查看提到的文件时需手动切文件树逐层找（移动端 v2 扩展的同一问题陈述）。

移动端方案已成熟（六轮评审 + 两个线上缺陷修复），识别规则（正则形态、排除清单、行号后缀、误报控制）全部移植；**管线形态不照搬**——桌面渲染栈不同，按本仓 streamdown 架构适配（§2.1/§2.2）。

契约事实（本轮实测核实，streamdown 2.5.0）：

- **裸 URI 自动链接桌面已有**：streamdown 默认 remark 插件含 remark-gfm（autolink literal），`http://…`/`www.…` 在 free text 已转链为 `<a>`，经本仓 `a` 覆写（`target="_blank"`）→ 主进程 `setWindowOpenHandler` → 系统浏览器。移动端自写 URI 分支是因其渲染器（flutter_markdown_plus）无 GFM autolink——**桌面不需要移植 URI 分支**。
- GFM autolink 对 autolink 产出的链接同样走 components.a 覆写（实测：自定义 `a` 组件收到裸链 href）。
- streamdown 渲染管线：marked Lexer 全文分块（每 token 全文 O(L)，既有成本）→ 块级 React.memo（比较键含 children 字符串与 `remarkPlugins` 引用）→ 变更块才重跑 remark 解析。**remark 插件只跑在变更块上**。
- `linkSafety: { enabled: false }`（本仓现状）下链接渲染为普通 `<a>`；enabled 时是 button + 确认弹窗（本仓不走）。

## 2. 设计

### 2.1 核心思路：remark 插件（mdast 层），非字符串预改写

移动端是「纯字符串预改写」：文本喂 `MarkdownBody` 前把裸目标重写为 `[text](ob-file:…)`，配合围栏状态机 + 组合正则（多反引号 span → 单反引号 span → 既有链接 → URI → 绝对路径 → 相对路径优先级交替）+ content-keyed memoize 缓存。

桌面改用 **remark 插件在 mdast 层插入 link 节点**，理由三条：

1. **性能模型（移动端 JANK-4 教训）**：预改写对全文 O(L) 正则每 token 重跑（移动端实测 5.0ms@32KB，是其全 app 卡顿主因之一，最终靠「未收尾 part 降级纯文本」绕开）。remark 插件跑在 streamdown 块级 memo 的解析管线内：流式期间仅变更尾块重解析，插件成本 O(块)；settled 消息每块只跑一次。**桌面无移动端的降级渲染（流式期间全量 markdown 渲染不变），插件方案不引入新的全文扫描**——marked 分块（既有）之后的 remark 解析按块 memo，是 streamdown 本来的性能边界。
2. **结构正确性**：围栏代码块/行内代码/既有链接在 mdast 是结构边界（code 块值在 `value`、行内代码是 `inlineCode` 节点、链接文本在 link 子树内），无需移植移动端的围栏状态机与「URI > 路径」组合正则优先级——URI 在解析期已被 GFM autolink 转为 link 节点，其子树文本本插件直接跳过，**优先级冲突被结构性消除**。
3. **memo 语义**：移动端自建 content-keyed 缓存（512 上限 FIFO）是因为其识别层要零上下文；桌面 memo 由 streamdown 块层承担（内容 + 插件引用比较），插件数组按 `directory` useMemo 稳定即可，无自建缓存。

插件形态沿用本仓 `cjkEmphasis` 的手写遍历约定（`markdown-cjk-emphasis.ts`）：`(options) => (tree) => void`，最小 `MdastNode` 接口，无 unist-util 依赖。

### 2.2 插件行为（mdast 遍历）

`messageFileLinks({ directory })`（`message-autolink.ts`）：

- `directory` 空 → 插件直接返回（不识别）。directory 来源 = 消息所属会话（`store.findSession(info.sessionID)?.directory`，MessageBlock 已有同款取值；SubagentMessageList 复用 MessageBlock，子会话消息取子会话自身 directory，天然正确）。
- 遍历整树（root/paragraph/heading/table cell/blockquote/list 通用），维护 `insideLink` 旗标：
  - **link 子树整体跳过**（既有链接不二次处理；GFM autolink 的 URI 由此天然不冲突）。
  - **text 节点**：对 value 跑路径正则（§2.3），每个匹配经归属校验（§2.4）通过后把 text 节点拆分为 `text / link / text / …` 序列；link 节点 `{ type: "link", url: fileHref(abs, line), children: [text(原字面)] }`。value 不含 `/` 跳过（微快退，同移动端全文快退的按节点版）。
  - **inlineCode 节点**：value trim 后是单一文件路径（`parseFilePath` 整串校验 + 裸域名排除）→ 整节点替换为 link（链接文本 = trim 后内容，反引号去除——移动端同构：`` `lib/foo.dart` `` 转链后是普通链接样式非等宽）；含其他内容/含空白/非路径 → 原样保留。多行 code span 的 value 含 `\n` 被「无空白」规则整体拒绝（移动端同款）。
  - **code 块（围栏）**：值在 `value` 不是 text 子节点，天然不触及（含未闭合围栏——streamdown 流式补全后再解析，同样不触及）。
- 节点替换用「重建 children 数组一次」的写法（同 cjkEmphasis 的 `next` 模式），避免遍历中变更索引。

### 2.3 识别规则（逐条移植自移动端）

| 规则 | 内容（与移动端一致） |
|------|----------------------|
| 相对路径 | `(?<![A-Za-z0-9_/.:])(?:\.{1,2}/)?(?:段/)+末段` |
| 绝对路径 | `(?<![A-Za-z0-9_/.:])/(?:段/)+末段` |
| 段字符集 | `[A-Za-z0-9_@+.-]+`（不含空格、反斜杠） |
| 末段 | `name.ext`（ext 1–10 位字母数字）或点文件（`.gitignore`）；`(?![A-Za-z0-9])` 尾边界 |
| 行号后缀 | `(?::\d+(?::\d+)?)?(?![A-Za-z0-9:])`——`:42`/`:42:10`，列号剥出后忽略；glued 字母整体拒绝（ME-2） |
| 必须含 `/` | 单段文件名（`main.dart`）不识别——散文误报控制 |
| 末段须带扩展名或点文件 | `Makefile`、`Dockerfile`、目录（尾 `/`）不识别 |
| 裸域名排除（MA-2） | 相对候选首段以常见 TLD 结尾（com/org/net/io/dev/app/co/cn/me/xyz，case-insensitive）不转链（`github.com/org/repo/…`）；`.github/workflows/` 点开头目录不误伤 |
| lookbehind 含 `:`（MD-1） | `localhost:8080/a/b.dart`、`C:/Users/x/y.dart` 不误转链。**语义易误读**：lookbehind 只防「从词中起匹配」（`xxlib/foo.dart` 的 `lib/` 处），整 token 从词首起匹配是合法转链（`xxlib/foo.dart` 整体转链——移动端同构，测试已固化） |
| 无空白 | 含空格路径不识别（自由文本与行内代码一致，移动端实现收严） |
| URI 优先 | 桌面结构性替代：URI 已是 link 子树，本插件跳过（`http://host/a/b.dart` 路径段不会被拆出） |

### 2.4 项目归属校验：解析期校验 + 绝对路径进 href（桌面语义变体）

移动端：识别层零上下文（缓存设计需要），项目外路径**照转链**，点击时 `resolveProjectPath` 校验失败 → SnackBar「文件不在项目中」。

桌面改为**解析期校验**：插件闭包 `directory`，每个候选先 `resolveProjectPath(path, directory)`，**失败（项目外/`..` 逃逸/空 directory）则保持纯文本不转链**；成功则绝对路径进 href。理由：

1. 移动端「识别零上下文」服务其 content-keyed 缓存（key 无需扩 directory）；桌面 memo 在 streamdown 块层（内容 + 插件引用），插件闭包 directory 不破坏 memo（directory 会话内稳定）——约束不存在。
2. 桌面**无 toast 基建**（本仓多处明载取舍）；「不可点」优于「可点但错误」正是移动端 MA-2 的论证原则，项目外路径保持纯文本是更优 UX 且零新反馈设施。
3. href 携带绝对路径后，点击处理器**零会话上下文**：`a` 覆写工厂可模块级构造、引用稳定（streamdown 块 memo 不失效）；移动端点击层要回查 session directory，桌面不需要。

`resolveProjectPath(path, directory): string | null`（**返回绝对路径**，移动端同名函数返回相对路径——移动端文件容器吃相对路径，桌面 `openFileTab` 吃绝对路径）：

- 绝对路径：须以 `directory + '/'` 开头，strip 后规范化；项目外 → null。
- 相对路径：对 directory resolve（`.`/`..` 规范化）后仍须位于 directory 内——`../../etc/nginx/nginx.conf` 逃逸 → null（MC-2 同款）。
- 规范化逻辑逐行移植（`_normalizeRelative`：空段与 `.` 跳过、`..` 弹栈、栈空逃逸 null）。
- 返回 = `directory + '/' + 规范化相对段`。

### 2.5 href 格式与点击路由

**href**（移动端同构）：`ob-file:///` + 路径按 `/` 拆段逐段 `encodeURIComponent` 再 join（`/` 保留、空格等 percent-encode）+ 可选 `?line=N`。绝对路径形态 = `ob-file:////abs/…`（前缀三斜杠 + 路径自带前导斜杠，移动端 MA-3 讨论中确认的既有格式）。不用 `file://`（与真实 file URL 及系统语义混淆——移动端决策 1 同款）。

**decodeFileHref**（逐行移植，MA-3/MC-1/ME-1）：字面前缀 `ob-file:///` 剥离（**禁用 `new URL(href).pathname`**——host 位为空时 `ob-file:///a/b` 的 pathname 带 `/a/b`，相对/绝对歧义）→ **仍在编码串上**按第一个 `?` 拆 `line=`（路径中合法 `?` 已编码为 `%3F`，先 decode 会腐蚀路径）→ `decodeURIComponent`（try/catch `URIError`，畸形编码返回 null）。返回 `{ path, line }` 或 null。

**点击路由**（markdown.tsx）：`Markdown` 新增可选 prop `onFileLink?: (href: string) => void`，经 `useMemo` 合并进 components（**同 `img` 覆写的既有模式**：调用方保持引用稳定，消息流恒传、文件预览恒不传）：

- `a` 覆写工厂：href 以 `ob-file:` 开头 → 渲染 `<a>`（无 target/rel——内部链接，§2.5a-2 须剥 hast 注入的 target/rel）+ `onClick` `preventDefault` + `onFileLink(href)`；其余链接维持现状（`target="_blank"` + 主进程 shell.openExternal，外链语义零改动）。
- MessageBlock 提供 handler（`useCallback([store, sessionDir])`，store 单例 + directory 会话内稳定）：

  ```ts
  (href) => {
    const decoded = decodeFileHref(href)
    if (!decoded) return
    const abs = resolveProjectPath(decoded.path, sessionDir ?? "")  // 点击层同源归属校验
    if (!abs) return
    store.openFileTab(abs, decoded.line ?? undefined)
  }
  ```

  **点击层同源归属校验（2026-10-11 评审修订 3）**：手写 `[x](ob-file:…)` 链接（assistant 输出可受 prompt injection 影响）不经插件（link 子树跳过）但同样渲染为可点 `a` 并进入本回调——`resolveProjectPath` 与解析层同源，项目外/`..` 逃逸/无 directory 一律静默拒绝；插件产出的 href 恒过校验。**禁用 window.open 路径**：`ob-file:` 非 http(s)，主进程 `setWindowOpenHandler` 本就 deny——preventDefault 后无系统侧动作，路由完全在 renderer。

### 2.5a 实现期联调实测（streamdown 2.5.0 契约事实，改渲染层前必读）

1. **rehype-sanitize 白名单拦截自定义 scheme**：streamdown 默认 rehype 栈 = raw + sanitize（rehype-sanitize，schema `protocols.href = [http, https, irc, ircs, mailto, xmpp, tel]`）+ harden。`ob-file:` 不在白名单 → **href 属性被 sanitize 剥除** → harden 呈 "Blocked URL: undefined [blocked]" 灰字指示（实测渲染为 span，无 `a`）。解法：`defaultRehypePlugins` 是 streamdown 导出面（`{raw, sanitize, harden}`），`Markdown` 在 onFileLink 存在时替换为同构栈——三件照搬默认，仅 sanitize schema 的 `protocols.href` 追加 `"ob-file"`；**模块级常量一次构造**（rehypePlugins 引用参与 streamdown 块 memo 比较）。harden 的 `allowedProtocols: ["*"]` 本就放行自定义 scheme，且 `new URL` 序列化对 4 斜杠绝对形态与 percent-encoding **往返保持**（实测）。
2. **hast 层给全部 `a` 注入 `target="_blank"` / `rel="noopener noreferrer"`**（streamdown rehype 管线装饰，实测）：外链路径无需任何处理（覆写 spread 透传即得既有行为）；**ob-file 分支须显式剥除 target/rel**——不剥则 spread 透传，target 触发主进程 setWindowOpenHandler 路径（deny 后无害，但语义错误）。
3. **streamdown 外层 memo 不比较 `remarkPlugins` / `rehypePlugins` / `components`**（上游特性，评审待确认项）：若 directory 晚于消息就位且文本不变，Streamdown 不重渲染、链接不出现。当前全部加载路径（主会话 REST 快照先入 map 再开 Tab；子会话 `session.created` 先于消息事件）directory 先于消息就位，未构造出触发场景；`img`/`remarkPlugins` 既有 prop 同受此特性影响（非本设计引入）。**失效条件**：若未来出现子会话消息先于 `session.created` 到达的 SSE 乱序路径，需在 directory 就位时强制重渲染（bump children 引用或 key）。sanitize 元组解构带上游形状守卫（非元组时降级不扩展，模块加载不崩——评审 nit 5）。

### 2.6 打开语义（Everything is a tab）

点击文件链接 = `store.openFileTab(absolutePath, revealLine?)`：

- **Tab 注册制**：`file:${absolutePath}` 去重复用（重复点击同一文件 = 复用已开 Tab，与文件树/关闭栈入口一致——AGENTS.md Tab 注册语义）。
- **行号**：`revealLine` 是既有机制（diff 跳转先例）：FileView 挂载消费（`consumeFileReveal` 一次性）、`revealLine != null` 强制源码模式 + CodeView 滚到行。**移动端 MA-1（`mdShowSource: line != null`——markdown 预览模式丢弃行号）在桌面是既有同构行为**，无需额外处理。无行号走保存的浏览模式。
- **文件不存在**：识别/点击层零存在性校验（同步识别零 IO，移动端决策 3 同款）；FileView 加载失败 UI 兜底。
- 作用域：openFileTab 归属当前作用域（与 diff 跳转同款路径，无新语义）。

### 2.7 覆盖范围

| 部位 | 是否转链 | 说明 |
|------|----------|------|
| assistant text parts | ✅ | 主场景 |
| user text parts | ✅ | 移动端同口径（用户粘贴路径可点） |
| user subtask prompt body | ✅ | 与 user text 同一渲染路径 |
| 子会话消息（SubagentMessageList） | ✅ | 复用 MessageBlock；directory 取子会话自身 |
| reasoning（思考折叠卡） | ❌ | 移动端同样不覆盖（正文专用）；避免向 ReasoningChip 穿线 directory/插件（见 §3） |
| 乐观消息（发送中回显） | ❌ | 瞬时态，真实消息到达即替换并转链 |
| 文件预览（FileView Markdown） | ❌ | 不传插件不传 onFileLink；文件内容中的路径字面不转链（那是文档不是会话） |
| URI（http/www/ftp） | — | GFM autolink 既有行为，本设计不触及 |

### 2.8 Markdown prop 组合重构（softLineBreak × remarkPlugins 解互斥）

现状：`remarkPlugins` 与 `softLineBreak` 互斥（softLineBreak 优先、caller 插件被忽略，user 管线恒走模块常量 `userRemarkPlugins`）。user 消息要转链必须两者可组合。

新组合规则（`useMemo`，deps `[remarkPlugins, softLineBreak]`；**2026-10-11 评审修订 1**）：

```
[cjkEmphasis, ...(remarkPlugins ?? Object.values(defaultRemarkPlugins)), ...(softLineBreak ? [softBreaks] : [])]
```

- **cjkEmphasis 恒排最前**（评审修订 1）：原公式把 cjkEmphasis 追加在调用方插件之后，messageFileLinks 先按路径拆 text 节点，`**` 配对跨节点失败——`**结论，见 src/a.ts 文档，**后续` 的 CJK 强调补救丢失（实测）。cjkEmphasis 必须在任何拆 text 节点的插件（gfm autolink / messageFileLinks / softBreaks）之前看到完整段落文本（§2.9 既有原则的推广，非仅 softBreaks）。对 FileView 无影响：relativeImageRewrite 只改 image/definition 节点 url，与 text 补救互不相关。
- **调用方契约不变**：caller 插件仍是「整体替换默认集、自拼默认件」（FileView 现行为），cjkEmphasis 仍自动注入（次序由本组件集中管理）。
- softLineBreak 不再吞掉 caller 插件，`softBreaks` 恒排最后（路径不含 `\n`，链接文本是路径无换行）。
- 消息流调用：`remarkPlugins = useMemo(() => [[messageFileLinks, { directory }], ...默认件], [directory])`——目录缺失时传 undefined（不转链）。directory 会话内稳定 → 数组引用稳定 → streamdown 块 memo 不失效。

## 3. 不做的事

- **URI 分支不移植**：GFM autolink 已任；移动端 URI 分支的全部修补（尾标点剥离/括号配平/`*` 强调剥离/全角终止）**不适用**。已知问题记录：GFM autolink 自身存在 MF-1 家族全角吞字（实测 `https://x/xxx（151` 的 `（151` 被 percent-encode 吞进 href）——**streamdown/remark-gfm 层问题，与本设计正交，修复另行立项**（可选路径：消息流 URI 预改写或上游修复）。
- **行内代码仅含单一 URI 的转链**（移动端有）：scope 是文件路径；`` `http://x.com` `` 保持 code 展示。
- reasoning 文本不转链（§2.7）——需要时可穿线 directory 另行扩展。
- 单段文件名、无扩展名末段（`Makefile`，点文件除外）、目录尾 `/`、含空格路径、Windows 反斜杠、`~/` home 相对、根级单段绝对路径（`/foo.dart`，MC-3）——移动端同款误报控制取舍。
- **多项目解析不做**：路径只对消息所属会话的 directory 校验；指向其他已开项目/其他 worktree 的绝对路径保持纯文本（移动端同口径——它的校验也只对 session.directory）。
- **文件存在性校验不做**（零 IO；不存在走 FileView 加载失败 UI）。
- **文本节点边界的 lookbehind 近似**：mdast 行内解析会把 text 拆成多节点（emphasis/link/softbreak 分隔），本插件按节点 value 起点判定 lookbehind，跨节点的紧邻词字符（如 emphasis 闭侧 `*x*` 后直接跟路径——raw 串里前驱是 `*`，两侧实现都转链）与移动端行为一致的**实际差异**仅剩「前驱是词字符且恰被行内结构拆开」的构造（如 link 节点尾随词字符后接路径），该形态下移动端原样拒绝、桌面可能转链——理论构造，接受为已知近似。
- 末尾部分切分不防护（`foo/1.0/bar` 只转链 `foo/1.0`，MD-2 同款）；`user@host/a/b.dart` scp 形态（ME-3 同款）——**与移动端实际一致：照样转链**（`@` 在段字符集内，相对路径 resolve 后位于项目内），可点但点击走 FileView 加载失败 UI。2026-10-11 评审修订 2：本节原表述「桌面解析期校验使误报自然消解为不转链」错误——解析期校验拦的是项目外/逃逸，相对形态误拼进项目内不构成拦截条件。
- 手写 `[x](ob-file:…)` 链接：link 子树跳过不二次处理（移动端同款）；点击层防御——非绝对路径/畸形编码静默忽略（移动端 ME-1 同款 try/catch 精神）。
- 不做 href 悬停提示（title 属性）与链接样式特化：转链后统一走 vendor github-markdown-css 的 `.markdown-body a` 样式（移动端「不保留等宽」同款取舍）。

## 4. 涉及文件

| 文件 | 变更 |
|------|------|
| `src/renderer/src/components/message-autolink.ts` | 新增：路径正则/`parseFilePath`/`isBareDomainPath`/`fileHref`/`decodeFileHref`/`resolveProjectPath` + `messageFileLinks` remark 插件（纯函数无 React/store 依赖） |
| `src/renderer/src/components/message-autolink.test.ts` | 新增：纯函数单测（移植移动端用例集的路径子集 + 桌面变体用例）+ 插件 mdast 变换单测（手建树，同 cjkEmphasis 测试法），30 例 |
| `src/renderer/src/components/markdown.tsx` | `onFileLink` prop + a 覆写合并（ob-file 分流、剥 hast 注入的 target/rel）+ `fileLinkRehype` sanitize 白名单扩展栈（§2.5a）；softLineBreak × remarkPlugins 解互斥（§2.8） |
| `src/renderer/src/components/markdown.test.tsx` | 组合回归（user 软换行 + 插件并存；onFileLink 路由分流、外链回归、无路由拦截形态），6 例 |
| `src/renderer/src/components/workspace.tsx` | MessageBlock：directory 取值（上移 hooks 区）+ 插件数组/handler（useMemo/useCallback 稳定引用）传入 assistant/user/subtask 三处 Markdown |
| `src/renderer/src/components/message-block.test.tsx` | 集成用例（store mock 改可变 hoisted 形态；路径转链 + 点击 openFileTab + 无 directory/乐观回显不转链），4 例 |
| `docs/spec/spec-v0.5.md` | 范围表 #12 + 验收口径同步 |

## 5. 验收（对齐 spec）

- [ ] 识别：相对/`./`/`../`/绝对路径、点文件、`path:42`/`:42:10` 行号 → 渲染为链接，行号进 `?line=`；`path:42,`/`（lib/foo.dart）` 尾标点留链外
- [ ] 排除：围栏代码块（含未闭合流式半块）、`open lib/foo.dart` 行内代码、单段文件名、无扩展名、目录、裸域名（`github.com/org/repo/…`）、`localhost:8080/a/b.dart`、`C:/Users/x/y.dart`、含空格路径、`and/or` 散文
- [ ] 既有结构不二次处理：`[t](u)` 链接、GFM autolink URI、`` `code` `` 非单一路径
- [ ] 归属校验：项目内路径 → 打开文件 Tab（复用去重、带行号跳行且强制源码模式、无行号走保存模式）；项目外绝对路径/`../` 逃逸 → 纯文本不转链
- [ ] 点击：链接点击 → 文件 Tab 激活；外链仍走系统浏览器（回归）；`ob-file:` 畸形 href 不崩溃不动作
- [ ] 流式：回复流式期间路径段落逐 token 出现，路径完整成段后转链（尾块重解析）；长消息流式不引入逐 token 全文重扫（块 memo 生效）
- [ ] 覆盖：user/assistant/subtask/子会话消息均生效；reasoning/乐观消息/文件预览不受影响；typecheck/test 全绿

## 6. 评审意见（2026-10-11，实现后代码评审）

| 编号 | 优先级 | 问题 | 处置 |
|------|--------|------|------|
| R-1 | 🟡 | 插件次序：messageFileLinks 拆 text 节点破坏 cjkEmphasis 的 CJK 强调补救——`**结论，见 src/a.ts 文档，**后续` 中 `**` 配对跨节点失败、加粗丢失（实测）；§2.8 原声称「拆 text 与插 link 互不相关」论断不成立 | ✅ cjkEmphasis 恒排最前（先于 gfm autolink/调用方插件/softBreaks，§2.9 原则的推广）；补回归用例（CJK 补救 + 路径转链同段并存） |
| R-2 | 🟢 | §3 ME-3 表述与实际行为相反：`user@host/a/b.dart` 的 `@` 在段字符集内、resolve 后在项目内 → 照样转链（与移动端一致），非「不转链」 | ✅ 文档修正为「可点但加载失败 UI」同移动端口径，标注修订 |
| R-3 | 🟢 | 手写 `[x](ob-file:…)` 链接绕过归属校验直达 openFileTab（弱化边界：prompt injection 可诱导开任意本地文件 Tab；实际影响有限——仅本地展示） | ✅ 点击层补同源 `resolveProjectPath` 校验（项目外/逃逸/无 directory 拒绝）；补手写越界拒绝/项目内放行集成用例 |
| R-4 | 待确认 | streamdown 外层 memo 不比较 remarkPlugins/components：directory 晚于消息就位且文本不变时链接不出现；各加载路径实测 directory 均先就位，未构造出触发场景（img/remarkPlugins 既有 prop 同受影响，非本次引入） | 📝 §2.5a-3 备忘 + 失效条件记录，不改代码 |
| R-5 | nit | sanitize 元组解构 `as unknown as` 硬 cast：上游升级改形状会在模块加载期 TypeError | ✅ `Array.isArray` + fn 类型守卫，非元组降级不扩展（功能回落、不崩） |
| R-6 | nit | linkReference 标签文本转链产生嵌套 `<a>`（无效 HTML） | ✅ linkReference 子树同 insideLink 剪枝；补插件用例 |
| R-7 | nit | `:0` 行号被接受（`?line=0`） | 📝 无害（移动端同构、CodeView 滚动钳定兜底），不动 |

评审验证通过项：resolveProjectPath 前缀/尾斜杠/逃逸、decodeFileHref query 拆分次序、softBreaks 组合、hooks 位置、文档落点与 commit 规范、main 进程 setWindowOpenHandler 仅放行 http(s)（ob-file 中键/ctrl 点击无 OS 动作）。
