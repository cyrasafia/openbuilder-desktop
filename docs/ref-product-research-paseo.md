# 调研：paseo

> 产品调研（`docs/ref-product-research-*` 系列）。对象：[getpaseo/paseo](https://github.com/getpaseo/paseo)（v0.9.2，克隆于 `../paseo`，快照 2026-09-25）。
> **以 paseo 为主轴**的调研记录；与 openbuilder 的对比为辅（§1.4 对照、§2.1 共性、§2.9 借鉴裁决、§3 总结）。范围限定：设计原则、功能两个层面，不做代码实现层面的调研（协议细节、性能管线、测试体系等均不在此篇）。
> 调研方式：文档 + git 考古为主，2026-09-25 起补充**实际上手使用**的验证（实测确认处以日期标注）。
> 引用格式：`paseo:docs/xxx.md` 指 paseo 仓库内文档。

## 0. 项目定位速览

paseo：本地 AI coding agent 的统一管理与监控环境（Claude Code / Codex / Copilot / OpenCode / Pi），自托管、无遥测。产品形态是一个**自研 daemon**——本地服务拥有 agent 进程与全部状态；Expo 移动端 / Electron 桌面端 / CLI / SDK 都是它的客户端。单人项目（Mohamed Boudra），Apache-2.0，2025-10 起步、5476 commits。

结构性事实（理解全文的前提）：daemon 是投影与状态的唯一所有者，且它是 5 种异构 harness 的编排层——这两点决定了它和直连型瘦客户端（openbuilder）的所有可比差异。

## 1. 设计原则

paseo 没有单一"设计原则"文档，原则分布在 `paseo:docs/product.md`（产品原则）、`paseo:docs/design.md`（视觉/交互设计语言，15 节）、`paseo:AGENTS.md`（工程与文档原则）。本节先梳理它**明确写下的**原则，再归纳**功能设计所隐含的**原则，最后与 openbuilder 对照。

### 1.1 明确写下的产品原则（product.md）

核心主张："**Paseo has a lean, opinionated core built to be extended**"（精简、有主见的内核，为扩展而建）。

- **工作流中心**（Agents are the focus）：核心工作流是"给 agent 任务 → 理解它在做什么 → 提供方向 → 审查结果"，一切产品决策服务于此；"familiarity alone does not make it a requirement"——别家工具的熟悉功能不因熟悉而入选。
- **低门槛高上限**：新手开箱即用（daemon 自动管理、扫码配对）；同时 daemon 可独立部署给自建基础设施的用户。
- **自由与所有权**：自托管、provider 自选、跨设备、无遥测、Apache-2.0。
- **演进节奏**（这条最值得注意，是元原则）："smallest useful change → ship → learn → next step"；"expanding a workflow too far before people use it creates commitments that are difficult to reverse"——把**以多大胆子做**写进原则。
- **扩展即泄压阀**：功能不进 core 但生态能做（插件/SDK 占 product.md 三节），"belongs in a plugin" 是砍功能时的标准退路。

### 1.2 明确写下的设计语言（design.md）

- **Character**："Minimal, spacious, quiet, confident"。总判据：**每个视觉决策只服务 act on this（操作它）或 understand this（理解它），绝不服务 look at this（看它）**。
- 层级靠字重与颜色不靠字号（三层字重制）；强调色是每屏至多一个的 CTA；"Destructive is a color, not a click"——红色只出现在确认对话框内部，出现在用户表达意图之后；"The whitespace is the design"。
- **可执行的文档形态**：Forbidden 清单（§14，14 条禁令，句式"X 是错的，Y 存在"）+ Canonical surfaces 表（§15，14 种界面模式→具体实现文件索引）。原则钉到 `packages/app/src/xxx.tsx:行号`。
- **状态纪律**（§11）：加载/空态/错误按最小作用域绑定（字段下/banner/弹窗三档不混用）；空态 = 短名词短语 + 至多一个 ghost 按钮；**"状态变化不得移动布局"**——badge 到达、流式数据到达不许引起已渲染内容的几何变化。

### 1.3 功能设计所隐含的原则

从 git 考古（5476 commits）和实测反推，paseo 的实际设计由以下隐含原则驱动——它们大多**没有写进任何文档**：

**① 能力齐全优于精简（与自述的 lean 相反）。** product.md 写 "lean core"，实际长成语音/relay/hub/cron/Git 写操作/浏览器自动化全做的 11-package monorepo。真实取舍标准是"能不能做 + 有没有人要"，不是"该不该进 core"——插件泄压阀极少真的启用，重功能都进了 core。

**② 能力默认全暴露。** "允许"与"鼓励"不分：多 provider 混排是开箱默认形态（不是可选路径）；workspace 允许同目录共用（`architecture.md` 明文 "Do not 'fix' the sharing away"）；diff 与文件平级进 Explorer 默认视图；左栏行尾默认渲染 diff 行数（`sidebarWorkspaceTrailing` 默认值即 "diff"）。能力存在即默认暴露，无"降层"概念。

**③ 跨端一致优于场景化。** design.md §9 声明 "Compact-first, the small case is designed"——实际是同一信息结构压缩排布：手机主屏复刻桌面工作区、全功能无削减（含手机上体验极差的 Terminal）、项目管理与 PC 同构（关闭即消失，重开 = 从路径新建，成本在手机上极高）。历史反讽：项目起点是手机（2025-10-21 voice-mobile app），桌面化后被桌面范式逆向殖民。

**④ 形态迭代优于理念推导。** 三栏布局不是设计出来的：起点语音手机应用 → 大屏加 agent 列表投影（2025-12）→ agent 列表撑不住改挂 workspace（2026-03）→ Explorer 2026-08 才成为一等面板。左栏粒度从 agent 转 workspace 是被规模逼出来的事后收敛。布局层没有任何理念约束——pane split 就是这么进来的（对桌面是空间充裕下的合理并置，但它从未被任何工作流论证挑战过）。

**⑤ 隐含的目标用户是 coder。** 这是最深的一条：diff 行数进左栏默认、Git 动作进标题栏、PR 状态无处不在——同时 PDF 无预览（全仓库零实现，文件渲染类型仅 markdown/html）、markdown 无 TOC、浏览器不能开本地文件。一抬一省：把开发者抬进第一层级，把非 coder 的产出物消费需求省略。product.md 全文没有用户画像定义，这条原则完全是无意识写成的——它从未被声明，因此从未被检验。

### 1.4 与 openbuilder 的对照

两家的原则文档文体同构（单核心原则 + 工作流推导 + 否决式判据），openbuilder 的对应物是 PRINCIPLES.md（"保持精简"）与 DESIGN.md。关键差异不在文本而在**效力**：

| | paseo | openbuilder |
|---|---|---|
| 原则与实现的一致性 | 自述 lean，实际全做；原则是**事后的叙事** | 排除决策全部可回溯到 PRINCIPLES 条目；原则是**事前的判据** |
| 用户画像 | 无定义（隐含 coder） | 显式"所有 builder，不止程序员"，"注意力单线程"直接成为布局判据 |
| 推导深度 | 工作流层为止，布局靠迭代 | 一路推到三栏与 Tab 结构 |

对照结论：**paseo 有设计原则，但没有很好地指导设计**。它的 product.md 与 openbuilder 的 PRINCIPLES 同样锋利，但功能来时按"能不能做"取舍、不按"该不该做"检验——lean 的自述约束不了体量，"fits a task" 的选择自由解释不了默认混排，"Compact-first" 防不住移动端被桌面殖民。可迁移的正面收获只有两点：演进节奏元原则（最小有用改动→上→学→下一步，openbuilder 尚未成文）；design.md 的可执行文档形态（Forbidden + canonical surfaces + 状态不移动布局）。

## 2. 功能

### 2.1 与 openbuilder 的共性（先共性后差异）

两款产品的核心界面形态高度相似，共四处，且都是"正确答案"级的收敛：

- **三栏布局**：左栏项目/workspace、右栏文件树（Explorer）、中栏工作区。paseo 的来历是迭代（§1.3 隐含原则④），openbuilder 的来历是原则推导（"注意力单线程 → 不分屏"），同构非同源——物理约束的趋同进化：多 agent 并行 + 人的注意力单线程 + 文件是产出物载体，解空间本来就窄。paseo 花约 5 个月、数千 commit 摸到的形状，openbuilder 一次推导到位。
- **左栏粒度到工作区而非 session**：paseo 起初是 agent 列表，2026-03 agent 数量爆炸后被逼转向 workspace 粒度（`sidebar-agent-list` → `sidebar-workspace-list`）——事后收敛到与 openbuilder "任务的载体是目录"相同的结论。两家同构的教训：若左栏太挤，答案是归并粒度，不是折叠列表。
- **工作区多 Tab**：中栏以 Tab 承载多视图（agent 聊天、文件、diff、终端、浏览器），而非分屏。paseo 在 Tab 之外另做了 pane split（§2.5 之外的扩展），openbuilder 停在纯 Tab——共性是"多任务用 Tab 切换"，分歧是 paseo 多走了半步。
- **worktree 意识**：两家都把 git worktree 作为多任务隔离的一等机制（paseo：workspace kind 之一 + 创建时 isolation 选项；openbuilder：左栏二级展示 + 简单创建/删除）。分歧在默认值——见 §2.2。

### 2.2 差异：多 provider 混排（立身功能）

不同 harness 的 agent 在同一界面并排打开、统一操作。时间线（git 考古）：2025-10-26 两种（Claude+Codex）→ 2025-11-15 统一 AgentManager + provider 架构 → 2026-01 OpenCode → 2026-04-02 "eliminate hardcoded provider unions"（架构承诺完成：任意 provider 插入即得完整 UI/时间线/权限流）→ 2026-04-04 Pi。前后 5 个月、~3300 commits。

技术路径的教训：先押注 ACP 统一协议，发现覆盖不了（各 harness 差异太大），最终形态是**界面统一契约 + 每个 provider 内部消化协议差异**。provider 数量增长与左栏粒度转向 workspace 同期（2026-02~03）——agent 变多且来源混杂逼出粒度上移，同一压力的两种症状。

### 2.3 差异：Workspace 隔离默认值

workspace kind 三种：`local_checkout` / `worktree` / `directory`（裸目录无隔离），允许多个 workspace 共用同一目录（一等事实）。两条配套铁律：git status/diff 是目录的事实、同 cwd 显示必须一致；草稿/展开路径等自有状态按 workspace 键控不得串。它防住了**视觉矛盾**，没防**写冲突**——两个 workspace 指同目录时，agent 写操作在文件系统层面并发冲突，无任何机制防护。worktree 隔离是创建时可选的 isolation 而非默认，"允许"再次压过"引导"（对照 openbuilder："一个 Agent 一个 worktree"是默认形态而非选项）。

### 2.4 差异：图形化 Git 写操作套件

`actions-store.ts` 动作全集：commit / pull / push / pull-and-push / refresh / discard-changes / 创建 PR / 三种 PR 合并 / 自动合并 / merge branch，另有提交图（commits-section）、切分支（branch-switcher）。Git 动作常驻 workspace 标题栏。这是一整套 GUI Git 客户端能力，且是**写**操作域。

### 2.5 差异：文件 Tab 单实例替换（preview tab 语义）

文件树点击第二个文件默认**原位替换**第一个（VS Code 式 preview tab）：单击走 `openPreferredWorkspacePreview`，目标面板激活 Tab 是未修改 file Tab（`canReplacePreview`：file→file 且 `!modified`）则 `replaceTab` 原位换 target。同开两个文件的唯一路径是右键 "Open to Side" 或先修改当前文件使其转正。Tab 意图系统为 `"new" | "reveal" | "background"` 三档。押注的高频场景是"连续查看大量文件"（无 Tab Flood），代价是切回旧文件丢滚动位置、"同时看两个文件"藏入口。

### 2.6 差异：未读/注意力标记

agent/终端跑完后标"已完成待查看"（attentionReason: finished），聚焦清除，工作区状态是所有 attention 的卷积汇总。实现依赖 daemon 作为 seen 比特的所有者——任一端已读，全体一致。通知路由与正确性分离（presence 不作为消息闸门）是这套模型里最干净的部分。

### 2.7 差异：自动化与编排周边

- **语音**（dictation + voice mode）：本地优先 STT/TTS（ONNX：Parakeet/Kokoro），语音模式复用已配置 agent；项目起点即此功能。
- **Cron 调度**（schedules + heartbeats）：定时起新 agent 做日常 triage/报告；heartbeat 周期性唤醒同一 agent。
- **浏览器自动化**：agent 驱动用户可见的浏览器 Tab（打开 dev server、点流程、截图自验），默认关闭、按 host 开启。
- **Agent 编排 MCP 工具集**：agent 起 agent / agent 间发消息 / 建 workspace，官方 skills（handoff/advisor/committee）的底座。
- **Paseo Hub**：多 daemon 上层——GitHub/Slack/Discord 事件触发 agent、团队共享、触发器入仓。
- 小件：agent profiles（配置组合）、metadata 生成（branch 名/commit 信息自动起名）、scripts、service proxy、终端活动 hook 注入、E2EE relay。

### 2.8 差异：手机端

见 §1.3 隐含原则③——信息结构复刻 PC（监督场景主屏应为 Agent 状态总览，实为工作区）、无功能削减、项目管理无场景区分（关闭即消失）。归在原则层记录，不重复。

### 2.9 差异功能汇总（是否借鉴）

§2.2–§2.8 全部差异功能的借鉴裁决一览——**结论：全部不借鉴**。理由留档，防止未来遇到同类功能诱惑时重新论证：

| # | 差异功能点 | 借鉴 | 不借鉴理由 |
|---|---|---|---|
| 1 | 多 provider 并行混排（§2.2） | ✗ | 评测视角冒充生产力视角：同时用多个 Agent 不是成熟工作流的常见形态，选型是低频决策（选定一个、用到底）；混排把"同时管理 N 种异构 agent"的复杂度摊给所有用户。openbuilder 的对应规划是服务器隔离 + 互斥激活（一次一个 server、一个 server 一种 agent），选择发生在"换"的时刻 |
| 2 | Workspace 同目录共用（§2.3） | ✗ | 牺牲安全度换自由性：agent 是无人值守的写手，同目录并行写几乎总是事故。openbuilder"一个 Agent 一个 worktree 独立工作"，把正确做法做成最容易的做法。可借半条：目录级事实按目录键控、workspace 级状态按 workspace 键控的纪律 |
| 3 | 图形化 Git 写操作套件（§2.4） | ✗ | 双重否决：GUI Git 是成熟软件做得非常好的功能域（用户有肌肉记忆与工具链，需要时丝滑迁移外部软件）；git 写操作属"编辑"不属"观察"，违背"主要做浏览"的取向。限定：diff/PR 的查看不在此否决射程内 |
| 4 | 未读/注意力标记（§2.6） | ✗ | 结构性不可迁移：依赖 daemon 作为 seen 比特所有者；openbuilder 直连 server 无未读水位，客户端各自记已读必然多端不一致。若未来做托盘角标，可循"每设备各自已读"定义（纯本地派生） |
| 5 | 文件 Tab preview 替换（§2.5） | ✗ | 工作流权重判断（非原则问题）：多开收益更高——验收需"消息 ↔ 产出物"对照、回切丢阅读进度打断读的连续性，比防 Tab Flood 更高频。Tab Flood 若成真痛点，答案是改进关闭快捷性而非替换语义 |
| 6 | 语音输入（§2.7） | ✗ | 输入法的职责，且现有输入法已做得很好（手机系统输入法语音键、桌面 fcitx5）；自建 STT/TTS 是"成熟软件做得好的不做"的教科书案例 |
| 7 | Cron 调度（§2.7） | ✗ | openbuilder 定位是瘦客户端，cron 要求它成为 service（常驻、守时、离线要跑）——客户端关了就停，形态错配；真需求的正确形态是 server 侧能力或外部 cron + REST |
| 8 | 浏览器自动化（§2.7） | ✗ | 本质是给 Harness 层增加工具能力，而 openbuilder 的定义是**监控管理 Harness 本身，不参与 Harness 的能力**；操作浏览器有更通用的方案（agent 侧 MCP 工具），放在客户端无额外加成 |
| 9 | Agent 编排工具集（§2.7） | ✗ | Agent over Agent 与"人监督 Agent"定位不符（人在链路中退位）；本质仍是接入 Harness，只是接入方从人换成 agent；方向价值本身存疑（真实协作是人选工具，非 agent 自动链） |
| 10 | Paseo Hub（§2.7） | ✗ | 与定位直接冲突：无中间服务层（D4）、单机瘦客户端；多机/团队/事件触发均不在范围 |
| 11 | 手机端形态（§2.8） | ✗ | 反面教材而非借鉴项：跨端一致是殖民不是设计。openbuilder 移动端自检——改动回答的是"手机场景的问题"还是"桌面功能怎么塞进手机" |
| 12 | 终端活动 hook 注入（§2.7 小件） | ✗ | 前提是 daemon 以 CLI 子进程管 agent、终端内是盲区需自报；openbuilder 终端本来就是 opencode server 的 pty，server 即状态所有者，无此结构性缺口 |
| 13 | E2EE relay（§2.7 小件） | ✗ | 自建专用加密 relay 是把接入层做成产品功能；openbuilder 的远程需求走**通用方案**：手机端用标准鉴权协议接入（OAuth code + PKCE + Authelia forward-auth，见移动端 `design-oauth-login.md`——客户端兼容标准鉴权，不自建传输层）；PC 端无需专门功能——VPN/Tailscale 方案成熟，客户端天然支持局域网直连 |

补充：差异功能全不借鉴，可借鉴项集中在**非功能层**——§1.1 演进节奏元原则（PRINCIPLES 增补候选）、§1.2 design.md 的可执行文档机制（Forbidden 清单 / canonical surfaces 表 / "状态变化不得移动布局"）。

## 3. 总结

**两款产品约 80% 的功能抉择和设计形态是相似的，但来自完全不同的路径**——paseo 靠迭代摸到，openbuilder 靠原则推导。相似的部分（§2.1 的三栏布局、左栏 workspace 粒度、多 Tab 工作区、worktree 意识）是物理约束的趋同进化：多 agent 并行 + 注意力单线程 + 文件是产出物，解空间本来就窄。paseo 花约 5 个月、数千 commit 摸到的形状，openbuilder 从工作流一次推导到位——这交叉验证了 PRINCIPLES 推导的质量。不同的部分（§2.2–§2.8）则集中暴露了两个差异源：

**① 原则是否真正指导设计。** paseo 有原则文档且与 openbuilder 文体同构，**但没有很好地指导设计**——自述与实现之间处处张力：一边写 "lean core"，一边语音/relay/hub/cron/Git 写操作全做；一边说 "fits a task"，一边默认并行混排；一边是移动起家，一边手机端被桌面范式逆向殖民。原则在 paseo 是**事后的叙事**，不是**事前的判据**——功能来时按"能不能做"取舍，而不是按"该不该做"检验。openbuilder 的原则是事前判据：本文档全部排除/维持决策的论证都可回溯到 PRINCIPLES 的具体条目。这是本次调研最重要的确认：**同一套判据，写在功能开发之前还是之后，决定产品长成什么形状**。

**② 目标用户的定义。** 功能取舍的分歧最终都收敛到这一个源点：**paseo 主要考虑 coder，openbuilder 面向所有 builder**。第一层级的抬与省（diff 行数进默认、PDF/TOC/本地网页缺失）、移动端的退化（监督场景主屏该是 Agent 状态却复刻桌面工作区）、编排的方向（agent over agent 的自动化 vs 人监督 agent 的驾驶舱）——分歧不是品味差异，是"这个功能为谁服务"的答案不同。coder 是 builder 的真子集：paseo 的每个功能对 coder 都自洽，但 openbuilder 的判据（"这个信号对非程序员 builder 有意义吗"）在 paseo 的世界里根本不存在。

对本项目的意义：paseo 用 5476 个 commit、11 个月，完整演示了"没有原则推导时一个有才华的开发者会长出什么"——答案是 **80% 与原则推导殊途同归，20% 分散在评测视角、coder 优先、桌面中心主义**。这 20% 正是 openbuilder 原则存在的理由。可迁移的收获集中在三处：演进节奏元原则（PRINCIPLES 增补候选）、design.md 的可执行文档机制（Forbidden 清单 / canonical surfaces 表 / "状态变化不得移动布局"）、以及本调研形成的**带理由的功能决策档案**——15 项排除与权衡留档在案，使它们不必在未来遇到同类诱惑时重新论证。