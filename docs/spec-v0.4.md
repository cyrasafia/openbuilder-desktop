# v0.4 功能范围

主题：**开箱即用**——从安装应用到第一次对话的完整闭环，外加输入面补全（附件）。承接 v0.1–v0.3 已落地能力（连接/聊天/项目/工作区/文件树/Tab 体系/diff 与各类预览/终端/浏览器等）。本文档确认 v0.4 范围与验收口径；各功能技术细节见对应 `design-*.md`（随实现产出）。

## 范围内

| # | 功能 | 说明 |
|---|------|------|
| 1 | 欢迎屏（首次启动引导） | **触发条件：启动时无激活 profile**（`activeProfileId` 为空；首次安装或删光 profile 后均触发），连过一次即不再出现，连接失败走现有 `connectionError` 展示。居中卡片向导（非三栏主界面）：**入口二选一**——managed（推荐，本机启动）/ attach（连接已有 server）。managed 分支：自动扫描二进制（见 #3）→ 找到则显示路径+版本、一键「启动并连接」（spawn + 健康 + 建 profile + connect）；未找到则显示**安装指引文案 + 安装命令复制按钮**（不自动安装，见范围外）+「重新扫描」+「改用 attach」。attach 分支：自动扫描（见 #3）发现项一键填入 URL，或手填 URL + 可选凭据，测试通过后保存连接。连接成功后 **provider 检查**：`GET /config/providers` 无任何已配置 key 的 provider 时进入 provider 配置引导（见 #4，可跳过）→ 完成进入主界面。「稍后配置」可跳过向导进主界面，中栏引导页保留「连接服务器」入口（回欢迎屏/开设置） |
| 2 | managed 模式配置流程完善 | ① profile 表单按模式分化：managed 隐藏 baseUrl/username/password（随机端口+自动凭据不变），新增**二进制路径**字段（默认自动发现，可手动指定/从扫描候选选择，取代 `OPENCODE_BIN` 环境变量 hack，env 仍优先生效）；attach 表单不变。② **版本检测**：扫描/spawn 前跑 `opencode --version` 展示；连接后 health 返回 version 校验最低版本（单全局 SSE 需 ≥ v1.0.66），低于**仅提示不阻断**。③ **崩溃自动重启**：managed server 非主动停止退出（现状：exit 事件发了但 renderer 没接）→ 主进程按退避自动重启（参考 design-terminal-tab §1.2a 退避思路，1s 起指数上封），重启成功通知 renderer 重连（走既有全量对账）；主动 stop（断开/切 profile/退出应用）不重启；重启期间连接状态可见（现有 connecting/disconnected 体系内表达 + 提示文案）。④ **日志可观察**：接入现有 `managed:event`（log/exit 当前无人订阅）——managed profile 的连接区/设置内提供 server 日志尾部只读查看（最近 N 行 + 复制），异常退出给可见提示 |
| 3 | 自动扫描 | **managed 二进制扫描**（欢迎屏与 profile 表单共用）：PATH + 常见安装落点（`~/.opencode/bin`、`~/.local/bin`、npm global bin、`/opt/homebrew/bin`、`/usr/local/bin`）→ 去重候选列表，逐项 `--version` 展示。**attach server 扫描**（欢迎屏与 attach 表单共用）：loopback 探测（默认端口 4096；不做网段端口扫描）+ **mDNS 发现**（main 进程 bonjour-service 浏览 `_http._tcp`，按 server 原生发布格式过滤 `opencode-{port}` 服务名——server 侧 `--mdns` 且非 loopback hostname 才发布，与 opencode 同库互通）；每个候选 `GET /global/health` 验证并显示版本，一键填入 URL。扫描均手动触发（进入向导/表单时自动跑一轮 + 手动重扫按钮），不后台常驻 |
| 4 | Provider/Model 配置 | 设置弹窗新增 **Provider 页签**：provider 列表（名称、source、key 配置状态、模型数，`GET /config/providers` 按当前作用域目录查）+ **API key 设置/删除**（`PUT /auth/{providerID}` `{type:"api", key}` / `DELETE /auth/{providerID}`，仅 API key 形态）。**Model 配置 = 默认模型选择**（复用现有「默认」页签 agent/model），provider key 配好而无默认模型时引导设置（欢迎流程内串接）。范围外见下（OAuth、config 编辑等） |
| 5 | 会话附件（文件与贴图） | 三个入口：**粘贴**（clipboard 图片 → 附件；文本粘贴不变）、**拖拽外部文件**进输入框（工作区文件树拖入仍是 source 引用不变，v0.3）、输入框**附件按钮**（系统文件选择器，多选）。通路（参考 openbuilder [design-attachments](../../../openbuilder/docs/design-attachments.md) + [design-image-attachment-thumbnail](../../../openbuilder/docs/design-image-attachment-thumbnail.md)，协议已验证：**无独立上传端点**，`FilePartInput` data URL 内联进 `prompt_async` parts）：读字节 → mime 推断 → 图片压缩（尺寸/质量上限）→ base64 data URL → `{type:"file", mime, url, filename}`；**客户端体积上限**（base64 后，默认 4MB；图片压缩后同限校验，超出拒绝并提示）。展示：输入区附件条（图片缩略图/文件 chip，可删，复用引用 chip 模式）；用户气泡 file part 渲染区分 source 引用与 data URL 附件（复用 v0.3 引用回灌渲染路径）；**图片缩略图 + 点击放大**；重开历史会话时接收侧缩略图**惰性生成**（从 data URL 惰性解码，不做同步全量解码——openbuilder 踩坑：内存膨胀+乐观→权威过渡缩略图丢失）。乐观消息附件随上屏 |

## 范围外（明确不做）

- **opencode 二进制自动安装/升级**（v0.1 已定范围外，0.4 维持）：仅检测 + 安装命令指引/复制；升级只做版本展示与低版本提示
- **provider OAuth / wellknown 登录流**（`/provider/{id}/oauth/*`）：仅 API key；OAuth 回调服务器、token 刷新留后续
- **opencode config 表单化编辑**（`GET/PATCH /config`、`/global/config`）与 MCP 管理、自定义模型定义——外部编辑器解决（不做大而全）
- LAN 主动网段端口扫描（mDNS 之外不扫网）
- 附件的 `SymbolSource`/`ResourceSource` 引用（维持 v0.3 范围外）；clipboard 非图片文件（文件管理器复制）粘贴；附件转工作区引用/落盘
- 欢迎屏多步骤产品介绍页（一屏完成，不做轮播引导）

## 新增 API 映射

| 功能 | API |
|------|-----|
| Provider 列表（含 key 状态） | `GET /config/providers?directory=` |
| API key 设置/删除 | `PUT /auth/{providerID}`（`{type:"api", key}`）｜`DELETE /auth/{providerID}` |
| 扫描验证/版本 | `GET /global/health`（复用，返回 version） |
| 二进制版本 | 本地 `opencode --version`（spawn 探测，非 HTTP） |
| 附件发送 | `POST /session/{id}/prompt_async` parts 扩 data URL 形态 `FilePartInput`（`url = data:<mime>;base64,…`，v0.3 仅用 source 形态） |
| mDNS 发现 | 非HTTP：bonjour-service 浏览 `_http._tcp`（与 server 发布同库互通） |

## 验收口径

- [ ] 全新数据目录启动（无 profile）出现欢迎屏；managed 分支扫描到本机 opencode 显示路径+版本，一键启动连接进入主界面；删除全部 profile 后重启欢迎屏复现；已有激活 profile 启动不出现
- [ ] 本机无 opencode 时欢迎屏给安装指引与命令复制，安装后「重新扫描」可继续；attach 分支手填 URL+凭据测试通过后保存并连接
- [ ] attach 扫描发现：本机 `opencode serve`（默认端口）出现在候选并可一键填入连接；LAN 内他机 `opencode serve --mdns`（非 loopback hostname）被发现、验证、填入、可连接
- [ ] managed profile 表单：URL/凭据字段隐藏，二进制路径可改且生效（改路径后连接用新二进制）；显示发现候选与版本
- [ ] kill 掉 managed server 进程：自动退避重启并重连，期间状态可见，恢复后消息/会话与 server 一致（对账无重复丢失）；主动断开不触发重启；server 日志尾部可查看、异常退出有提示
- [ ] 连接低于最低版本的 server（含 attach）有版本提示但不阻断使用
- [ ] Provider 页签：列表与 key 状态正确（含按作用域目录）；设置 key 后对应 provider 模型可选用并能完成一次对话；删除 key 后失效；无任何 key 时欢迎流程出现配置引导且可跳过；配好 key 无默认模型时引导设置默认模型
- [ ] 粘贴截图/拖入外部图片/附件按钮选图：输入区出现缩略图 chip 可删除；随消息发送后用户气泡正确渲染附件、AI 能读到内容并正确回应；超限文件（>4MB base64 后）被拒绝并提示原因
- [ ] 任意非图片文件（拖入/按钮）同通路发送成功且渲染为文件 chip；工作区内文件树拖入输入框仍走 source 引用（不内联 data URL）
- [ ] 重开含图片附件的历史会话：缩略图正常显示（惰性生成）、点击放大可用；无同步解码卡顿
