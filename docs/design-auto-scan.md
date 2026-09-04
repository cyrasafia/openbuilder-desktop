# 自动扫描设计（managed 二进制 + attach server）

对应 [spec-v0.4.md](./spec-v0.4.md) 功能 #3。为欢迎屏（#1）与 profile 表单（#2）共用的扫描基础设施；本文只覆盖扫描能力本身（main 进程 + IPC 面），UI 消费随 #1/#2 落地。

## 1. 范围与原则

- 两类扫描：**managed 二进制扫描**（本机找 `opencode` 可执行文件并探测版本）、**attach server 扫描**（发现可连接的 opencode server 并验证）
- **手动触发、一次收束**：调用方（欢迎屏/表单）进入时自动跑一轮 + 手动重扫按钮；扫描是单次 Promise，完成后全部资源（mDNS browser 等）释放，**不后台常驻**（spec 明确）
- 扫描在 **main 进程**执行（要 spawn 子进程、UDP 多播，renderer 沙箱做不了）；结果经 IPC 一次性返回

## 2. 二进制扫描（scanBinaries）

### 2.1 候选目录

按序收集、去重（`path.resolve` 归一）：

1. `PATH` 各目录（用户 shell 环境的天然发现面，排在最前——首个命中即推荐项）
2. `~/.opencode/bin`（官方安装脚本默认落点）
3. `~/.local/bin`（用户级手动安装惯例）
4. **npm global bin**：`npm prefix -g` 输出 + `/bin`（仅 posix；spawn 失败/超时 3s 静默跳过——npm 缺席或慢盘不阻塞扫描）
5. `/opt/homebrew/bin`（Apple Silicon Homebrew）
6. `/usr/local/bin`（Intel Homebrew / 手动安装惯例）

每目录探测文件名 `opencode`（win32 额外探测 `opencode.exe` / `opencode.cmd`——npm Windows 落点），`fs.access` X_OK + `stat().isFile()` 双重判定（POSIX 下目录恒 X_OK 可执行，单用 access 会把同名目录收进候选）。命中后 `fs.realpath` 去重（`~/.opencode/bin` 常为指向版本目录的 symlink，与 PATH/落点重复的只留一个，保留先序出现者）。

win32 特别处理：npm global bin 免 spawn `npm`（npm 本身即 `.cmd`，见下），直接取标准落点 `%APPDATA%\npm`（bin 直接在 prefix 下、无 `/bin` 后缀）；`.cmd` 候选的 `--version` 探测经 `cmd.exe /d /s /c` 包裹（`windowsVerbatimArguments: true` 保引号原样）——Node 的 CVE-2024-27980 加固拒绝无 shell 直接 spawn `.bat/.cmd`。

### 2.2 版本探测

- 逐项 `execFile(bin, ["--version"])`，**3s 超时**（并发 4，**按发现序定位写入结果**——并发完成序不定，推荐项 = `results[0]` 必须稳定）
- 版本 = stdout 首行 trim（实测 `opencode --version` 输出裸版本串如 `1.18.20`）
- 失败/超时 → `version: null`（候选仍保留，用户可手动选用；不可执行的候选没有意义，不进列表）
- 子进程 env 用 `sanitizedChildEnv`（复用 linux-open-with.ts：防 dev 模式 NODE_ENV 泄漏破坏子进程行为）
- 扫描**探测阶段** 10s 兜底截止（版本探测发起前起算）：到点后未发起的探测以 `version: null` 保留候选（不整项丢弃），在途的等待收束；此前的目录探测/realpath 阶段无独立超时（网络挂载 PATH 目录理论可长挂，现实罕见，接受）

### 2.3 结果

```ts
interface BinaryCandidate { path: string; version: string | null }
```

按发现序返回（PATH 序优先 = 推荐项即首项）。

## 3. server 扫描（scanServers）

### 3.1 loopback 探测

- `GET http://127.0.0.1:4096/global/health`（2s 超时）——**只探默认端口 4096**，不做端口段扫描（spec：范围外）
- `healthy === true` → 候选（source: `loopback`）

### 3.2 mDNS 发现

- **bonjour-service ^1.3.0**（与 opencode server 发布侧同库、允许 1.x——仓库 `^` 惯例）浏览 `_http._tcp`（`find({ type: "http" })`）
- 服务名过滤 `^opencode-\d+$`：server 侧发布格式为 `name: opencode-{port}`、`type: http`、`txt: { path: "/" }`，且仅 `--mdns` 且非 loopback hostname 才发布（server 源码 `mdns.ts` / `server.ts` setupMdns 核实）
- **浏览窗口 4s** 后收束：窗口内 `service-up` 事件累积候选，随后 `bonjour.destroy()` 释放（dgram socket 不残留）
- **URL 构造必须用 `service.addresses` 的 IP**（A/AAAA 记录）：Node fetch 的 DNS 解析不走 mDNS，`opencode.local` 这类 host 名解析不开；**IPv4 优先**（AAAA 在前且 v6 不可达时候选不因首选地址而整条丢失）；IPv6 地址按 RFC 3986 加方括号（`http://[fe80::1]:4096`）。addresses 空的 service 无法构造 URL，丢弃
- **error 事件兜底（review P1）**：bonjour-service 1.3.0 的 dgram socket bind 失败（EACCES / 5353 被占）时 multicast-dns 向底层 emit `"error"`，无监听者 = uncaughtException 崩主进程——真实 factory 创建后对 `server.mdns` 挂 no-op error 监听（upstream 未暴露公开入口，经内部结构访问并注明），使 mDNS 静默降级为纯 loopback

### 3.3 验证与去重

- 窗口收束后对全部候选（loopback + mDNS）统一 `GET /global/health` 验证（2s 超时），`healthy === true` 才保留，并取 `version` 展示
- 按 URL 去重；loopback 与 mDNS 命中同一 server（bind 0.0.0.0 + `--mdns` + 默认端口）时 URL 不同（127.0.0.1 vs LAN IP），**两条都保留**（对 attach 都是合法入口）

### 3.4 结果

```ts
interface ServerCandidate {
  url: string          // 形如 http://192.168.1.5:4096
  version: string | null
  source: "loopback" | "mdns"
}
```

整体耗时上界 ≈ 4s（mDNS 窗口）+ 2s（验证）；无 mDNS 网络时 bonjour 仍能在窗口内正常收束（无事件即空集）。mDNS 库异常（多播不可用等）捕获后降级为纯 loopback，不让扫描整体失败。验证阶段复用并发 4、无独立整体 deadline——候选数 n 全不可达时 ≈ ceil(n/4)×2s（同网段 opencode server 数量小，接受）。

## 4. IPC 面

| 通道 | 方向 | 返回 |
|---|---|---|
| `scan:binaries` | renderer → main | `BinaryCandidate[]` |
| `scan:servers` | renderer → main | `ServerCandidate[]` |

- preload 暴露 `scanBinaries()` / `scanServers()`（`ipcRenderer.invoke`，类型进 `DesktopApi`）
- 扫描不可重入去重：同通道并发调用复用同一 in-flight Promise（防欢迎屏 StrictMode 双触发重复 spawn 一串 `--version` 子进程）
- 无进度事件推送（单次收束；4s mDNS 窗口由调用方 UI spinner 覆盖）

## 5. 模块与可测性

- `src/main/scan.ts` 单文件：`scanBinaries(deps?)` / `scanServers(deps?)`，依赖注入默认真实实现——
  - 纯函数直接单测：候选目录收集（PATH 解析/去重/顺序/`~` 展开）、版本行解析、mDNS 服务名过滤、mDNS URL 构造（v4/v6/addresses 空）
  - `execFile` / `fetch` / `access` / `realpath` / `Bonjours` 构造器均可注入，集成层用桩测（超时路径、失败降级路径）
- 不引入 `@opencode-ai/sdk`（硬约束）；`/global/health` 契约与 managed-server.ts 的 waitHealthy 同源

## 6. 已知取舍

- 不扫网段、不扫端口段（spec 范围外）；非默认端口的 LAN server 只能靠 mDNS 或手填
- npm global bin 探测依赖 `npm` 可执行（bun/pnpm 全局装的 opencode 靠 PATH 命中，不单独探测其落点）
- mDNS 服务名只认 `opencode-{port}` 格式，server 自定义 `--mdns-domain` 不影响发现（name 不含 domain）
