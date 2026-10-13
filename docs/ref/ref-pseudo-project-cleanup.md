# ref: 伪项目（pseudo project）成因与清理方法

> 性质：参考资料（数据中心运维手册）｜ 首版：2026-09-29，基于当日 v2.0.18 server（端口 15120）全量清理实战｜ 2026-09-30 增补：燃料模型实证（§3.3）、顽固行剥洋葱（§5.2）、worktree 开发测试善后实录（§7b）｜ 2026-10-12 增补：warm location 周期刷新燃料与 evict 端点（§3.4/§5.2）、当日实战（§7c）、项目列表过滤裁定否决（§8）；同日自动化落地——桌面端 removeWorkspace 删除成功后自动 evict（design-worktree-sync §3.4，原 todo-worktree-delete-location-evict）｜ 2026-10-13 增补：git 身份输入变更的同路径双行（§3.5，非伪行）、§5.2 anything 处置实例、当日实战与 16 分钟观测（§7d）；同晚三易其稿——证伪「刷新即建档」后**定位真触发器**（location 请求 → resolve → 兜底建档，一发一行，§5.2 有诊断式），§3.4 定稿 + 实验记录（§7e）
> 关联：`../openbuilder/docs/docs/todo/todo-ghost-worktree-projects.md`（客户端视角的同类问题记录，其「修复方向 3：一次性清理」本文即实施方法）

## 1. 定义与判定指纹

**伪项目行**：`project` 表中 canonical（列名 `worktree`）无法对应真实 git 仓库、由**目录哈希兜底建档**产生的行。

判定指纹（满足任一高度可疑，组合即确诊）：

- `canonical` 指向 `~/.local/share/opencode/worktree/` 路径——v2 规范模型下 canonical 永远是主仓目录，**必为伪行**
- `vcs IS NULL` + `name` 空 + `sandboxes='[]'`（标配长相）
- projectID 不符合 `sha1("git-remote:" + 规范化 remote URL)` 方案（git 项目恒等式，见 openbuilder TODO 文档源码分析）

注意术语：DB 列名叫 `worktree`，**v2 API 负载字段叫 `canonical`**（客户端内部模型沿用 v1 的 `worktree` 名，映射点在 `src/shared/v2-adapter.ts`）。验证 API 时按 `canonical` 过滤——按 `worktree` 过滤会**假阴性**（2026-09-29 实测踩坑两次）。

## 2. 三种残留形态

| 形态 | 特征 | 清理难点 |
| --- | --- | --- |
| **死目录** | 磁盘不存在 | 删行会再生（有燃料时）；`refresh` 能清库存但清不了 project 表 |
| **空壳目录** | 目录存在但只剩残渣（如 `.idea`），**无 `.git`** | 最隐蔽：`DELETE /api/worktree` 因非有效 git worktree 失败；`refresh` 因目录存在不视为死行——**先 `rm -rf` 再 `refresh`** |
| **旧路径孤儿** | 项目搬迁（如 `~/协作工作区/…` → `~/projects/…`）后 session.directory 仍指旧路径 | 需迁移会话到新路径，不能只删行 |

## 3. 成因机制

### 3.1 兜底建档（server 侧根源）

```
目录 → git 解析（rev-parse + remote get-url）
  ├─ 成功 → projectID = sha1("git-remote:" + remote)，worktree 归属主项目
  └─ 失败（目录已删/非 git/空壳）→ projectID = 目录哈希
          → upsert 一行 canonical=该目录 的伪项目行（只写不删，永久残留）
```

对照组实证：`calm-wolf`（活 worktree，531 次引用）git 解析成功归入主项目，**0 伪行**；死目录每次被解析即 upsert。

### 3.2 触发入口（谁会让 server 解析目录）

| 入口 | 实证 |
| --- | --- |
| **带 `location[directory]` 的请求打到死目录**（vcs 面板轮询为代表） | **确定性触发，一发一行**（§3.4 三订；§5.2 两条 curl 可复现） |
| `GET /api/project` 的目录扫描（解析未归档会话的 directory） | 一次调用后 3 秒起 1 行/秒 × 64 秒重建 105 行（704 次 realPath 探测） |
| 客户端 SSE 订阅（`location.directory`=死目录） | 幽灵 Tab 每 5-20 秒触发一次 realPath |
| 客户端持久化状态（打开的项目/Tab 引用已删 worktree） | 删行 12 秒后重生 |
| v1→v2 迁移存量（v1 按目录建档，整批带入） | 首次盘点 101 条（2026-09-29 记录） |
| **worktree 功能测试**（建 worktree → 建测试会话 → 删目录） | 分支挂载开发两天产生 18 个死目录伪行（2026-09-30） |
| **清理验证脚本自身** | `final-verify-<ts>` 等会话建在生产库——验证动作成为燃料（2026-09-30） |
| **server 重启解析自身 cwd** | `/home/cyrasafia` 伪行在每次重启后复活（cwd=home），上游问题暂无解 |

### 3.3 燃料模型（为什么删不干净）

伪行再生需要「有人引用死目录」。燃料清单（2026-09-30 全部实证）：

1. **未归档会话**挂在死目录（主力燃料；server 扫描 sweep 数据源）
2. **`project.sandboxes` JSON 死条目**（冻结 legacy 列）——**实证为活跃燃料**：quiet-mountain 归档会话 + 清库存登记后仍再生，清此列才断根。该列无写 API（server 唯一写点 = insert 空数组，onConflict 不更新），SQL 直改后**不会被内存态回写**
3. **`project_directory` 库存死登记**——挂在**父项目**下，删伪行不级联它，须补刀 SQL（§5.2）。注意：登记本身被内存回写后**不再触发行重建**（解析触发源才是关键，2026-09-30 实证）
4. **客户端活动引用**（幽灵 Tab / 打开状态 / SSE 订阅）
5. **server 内存态回写**（一次性：凭空重建后不再生——proud-cactus 无任何 DB 引用被重建一次，重删即断，无须重启 server）
6. **location 请求触发兜底建档**（§3.4，2026-10-13 三订：触发器已定位）——任何带 `location[directory]=<死目录>` 的请求（桌面端 vcs 轮询为代表）都会 boot location → `project.resolve` → 目录哈希建档；**一发一行**，与 warm/刷新/时机无关。**与燃料 1-3 正交**；预防 = 断请求源（删前停轮询），evict/重启只治死驻留、防不住本机制

**燃料灭则火灭**：归档全部未归档会话 + 客户端断开后，删行实测 60-120 秒零再生（燃料 1-5 口径；若命中燃料 6 须按 §3.4 另断——归档会话无效，仅断 SSE 订阅也不够，须停掉 location 请求源（vcs 轮询））。

**单行可穿多层燃料**：quiet-mountain 依次穿透 1→3→2 三层才断根（归档 4 条会话→仍再生→补刀 6 条库存登记→仍再生→清 sandboxes 死条目→断根）。顽固行按 §5.2 剥洋葱处理，每剥一层删行重验。

**归档判定陷阱**：未归档 = `time_archived IS NULL` **或 `time_archived = 0`**。v1 迁移产生大量 epoch 零值（`0` 非 NULL），按 `IS NULL` 归档会漏——漏网的恰好是手机端渲染出来、且持续再生的那批。app 侧判定同源：`time.archived != 0` 才算归档（openbuilder `models.dart`）。

### 3.4 location 请求触发兜底建档（燃料 6；2026-10-13 深夜定位触发器，三订）

**机制（确定性复现，§7e）**：**任何携带 `location[directory]=<目录>` 的请求**都会让 server 的 location 中间件按需 boot 该目录的 location 服务——boot 即 `project.resolve(目录)`（`core/src/location.ts:24`）；而 `FSUtil.resolve` 对不存在的路径**回退返回原路径**（`util/fs-util.ts:105-111`；两处源码锚均 v2.0.24 tag 核对），因此对**已删除**的目录 resolve 照样走完 → git 解析失败 → §3.1 目录哈希兜底建档。**一发请求一行**，与 warm、5 分钟刷新、删除时机全部无关。请求本身多半 404（boot 后续失败），但**建档副作用已发生**——这是它隐蔽的根源。

**桌面端的请求来源**：vcs 面板轮询 `GET /api/vcs/diff?location[directory]=…`（deepObject query）。删除 worktree 的瞬间/之后，对已删目录的最后一次轮询（在途或事件触发）即建一行。

**背景事实（相关但非触发器）**：warm location 死驻留成立——`location-services.ts` `idleTimeToLive: Duration.infinity`（LayerMap 层永不闲置淘汰），死目录 location 实测驻留 ≥10 分钟、每 5 分钟照常发 `provider.updated`/`model.updated` 事件；但刷新本身**不建档**（实验证伪，§7e）。kind-otter 的 5 分钟事件节律（293 次/27 小时）是 warm 在场的**标记**，不是建档证据。

**案例归因（三订）**：neon-wizard（10-13 删除同秒建 1 行）= vcs 轮询落在删除后的死目录上；quick-circuit 同日删除无行 = 恰好没有请求落上去——纯时序差异，非竞态窗口。10-10 21:17 批（15 秒 19 行、约 1 行/秒）= SQL 删行后，桌面端对账/轮询循环对 19 个死目录**串行各发了一发** location 请求。

**断根口径**：

- **客户端预防（治本，待落 design-worktree-sync §3.5）**：removeWorkspace 删除前停掉对该目录的 vcs 轮询 + 等 in-flight 的 location 请求落地（或短延迟）——删除后没有请求打向死目录，就不会建行。
- **evict / server 重启**：只清 warm 驻留与事件噪声，**防不住本机制**（后续请求会 re-boot location 再 resolve）；自动化 evict 的保留价值 = 死驻留治理（§5.2 处置式仍适用）。
- **SQL 删行**：若客户端还在向死目录发 location 请求，删了会被下一发重建；先断请求源再删。
- **判别口径**：死目录行再生时，查客户端是否有带 `location[directory]` 的请求发向它（桌面端 = vcs 面板/作用域相关轮询）。server 日志难鉴证——2xx 不落日志，404 行不携带 location 参数、无法归因到具体目录；复现/验证一律用 §5.2 诊断式。

### 3.5 git 身份输入变更 → 同路径双行（合法身份行，非伪行；2026-10-13 实证）

**机制**：git 身份 = `remote(origin) ?? 钉住文件(.git/opencode) ?? 根提交`
（v2.0.18 `project.ts` resolve 的优先级）。**origin 的添加/变更会切换身份输入**：
无 origin 时身份落到钉住文件或根提交；加了 origin 后身份变为 remote 哈希，且
优先级压过钉住文件——防漂移机制失效。新身份 resolve 会 upsert 新行，并发出
`Worktree.Event.Resolved{previous=老id}`，`session/projector.ts` 把该目录下挂在
老身份的会话重挂到新身份（v2 表；重挂以 `workspace_id IS NULL` 为条件，
workspace 作用域会话须手工重指向——订前例的 v2 1 条即此，推断未单独实证）；
老行 upsert-only 不回收 → 同路径同名两行。

**与伪行的区别**：两行 `vcs=git`、都对应真实仓库，不满足 §1 确诊组合，不要按
伪行清。唯老行 id 是根提交、单看 §1 第 3 条公式会呈「高度可疑」——那是无
origin 期的合法身份，勿据此动手。清法是 §5.2 同路径双行重指向（重指向后删老行），
另需同步更新钉住文件与客户端持久化里的老 id，否则身份还会漂回。

**实证（anything）**：老行 `6890936f…` = 仓库根提交（09-11 建行，当时无 origin）；
09-28 12:05 server 把该身份写进钉住文件 `.git/opencode`（老行 `time_updated` 同秒）；
10-12 17:22 `.git/config` 加 origin；10-13 00:08:42 一次 location evict→re-boot
重新 resolve → 新行 `9e15fb7e…` = `sha1("git-remote:github.com/cyrasafia/anything")`。
处置后：v1 表 23 条会话重指向新行、老行删除，钉住文件与客户端持久化老 id 已同步。

同型第二例（订前Agent优化，09-28，时序更紧）：11:26:50 钉住文件写入老 id
`c139e90b…` → 11:27:39 `.git/config` 设 origin（codeup）→ 14:13 新行
`3dd5d7bc…` = 当前 origin 的 remote 哈希。处置同式：v1 2 条 + v2 1 条重指向、
删老行、钉住文件同步。

## 4. 数据库速查（`~/.local/share/opencode/opencode.db`）

### 4.1 关键表与外键级联

```
project ──CASCADE──→ project_directory
        └─CASCADE──→ worktree（库存登记）
        └─CASCADE──→ session ──CASCADE──→ message ──CASCADE──→ part
session_v2（镜像）──CASCADE──→ session_message / session_inbox
                    └─CASCADE──→ project
session_share / todo ──CASCADE──→ session
```

**危险点：删 `project` 行会级联物理删除其名下全部 session 及消息**（global 行挂 85 条 v1 会话的案例）。删行前必查 `SELECT COUNT(*) FROM session WHERE project_id='<id>'`。

### 4.2 sqlite3 CLI 注意

- 默认 `PRAGMA foreign_keys = OFF`——**级联不生效**，须显式 `PRAGMA foreign_keys=ON;`
- SQL 字符串字面量必须**单引号**（双引号被解析为标识符）
- DB 常驻 WAL 模式，与运行中 server 并发写安全但有**竞态**（见 §6）

## 5. 清理方法

### 5.1 判定清单（动手前先盘）

```sql
-- 伪行全量
SELECT id, worktree, vcs FROM project WHERE worktree LIKE '%opencode/worktree%';
-- 死目录上的未归档会话（燃料 1；注意 =0 陷阱）
SELECT directory, COUNT(*) FROM session
WHERE (time_archived IS NULL OR time_archived=0) GROUP BY directory;
-- 库存死登记（project_directory 挂父项目下，删伪行不级联；磁盘存在性 shell 侧判）
SELECT project_id, directory FROM project_directory WHERE directory LIKE '%…%';
-- 各项目 sandboxes 死条目（§3.3 燃料 2）
SELECT id, sandboxes FROM project WHERE sandboxes != '[]';
-- 伪行挂载量（删行 = 级联物理删挂载会话，删前必查）
SELECT p.worktree, (SELECT COUNT(*) FROM session s WHERE s.project_id=p.id),
       (SELECT COUNT(*) FROM session_v2 s WHERE s.project_id=p.id)
FROM project p WHERE p.vcs IS NULL;
```

磁盘存在性在 shell 侧判（SQL 无法 stat）：导出目录列表逐个 `[ -d ]`。

### 5.2 处置三式

**归档**（默认，可逆、不丢历史）——断 server 扫描燃料，app 侧同时隐藏：

```sql
PRAGMA foreign_keys=ON;
UPDATE session    SET time_archived=<now_ms> WHERE directory IN (…) AND (time_archived IS NULL OR time_archived=0);
UPDATE session_v2 SET time_archived=<now_ms> WHERE directory IN (…) AND (time_archived IS NULL OR time_archived=0);
```

**迁移**（项目搬家的旧路径孤儿首选）——三字段双表：

```sql
UPDATE session    SET directory='<new>', path='<new>', project_id='<目标项目行>' WHERE directory='<old>';
UPDATE session_v2 SET directory='<new>', path='<new>', project_id='<目标项目行>' WHERE directory='<old>';
-- 目标 project_id 取新目录现存会话的主流值，避免同名多行二义
```

**删除**（伪项目行本身）：

```sql
PRAGMA foreign_keys=ON;
DELETE FROM project WHERE worktree LIKE '%opencode/worktree%';  -- 库存随级联清
```

**同路径双行重指向**（同一目录既有 git 行又有伪行时，伪行挂的真实会话无损转移）：

```sql
UPDATE session    SET project_id='<同路径 git 行 id>' WHERE project_id='<伪行 id>';
UPDATE session_v2 SET project_id='<同路径 git 行 id>' WHERE project_id='<伪行 id>';
-- 然后删伪行；2026-09-30 Agent-Engine 案例实证
```

2026-10-13 anything 案例：双行**均为合法 git 身份行**（成因见 §3.5，origin 添加切换
身份输入），同式重指向 23 条 v1 会话后删老行。另需同步两处，否则身份漂回：
钉住文件 `.git/opencode` 改写为新 id；客户端持久化（store.json 的
`project.state.*.opened` / `currentProjectId`）里的老 id 换成新 id。

**顽固行剥洋葱**（删后仍再生的行，按序剥层，每剥一层删行重验）：

```sql
-- ① 归档该目录全部未归档会话（双表，见上）
-- ② 补刀 project_directory 死登记（挂父项目下，删伪行不级联它）
DELETE FROM project_directory WHERE directory LIKE '%<死目录>%';
-- ③ 清父项目 sandboxes 死条目（冻结列无 API；server 不回写此列，SQL 直改即终态）
UPDATE project SET sandboxes='[]' WHERE id='<父项目>';  -- 或从 JSON 数组中仅剔除死条目
-- ④ 删伪行；若仍再生且 DB 无任何引用 → server 内存态（一次性），重删一次即断
```

**空壳 worktree**（先断目录再走正规通道）：

```bash
rm -rf <空壳目录>                       # 确认只剩 .idea 等残渣
curl -X POST …/api/worktree/refresh -d '{"projectID":"<pid>"}'   # 204 = 库存死行自动清
# refresh 只清 worktree 表；project_directory 残留须补刀 SQL 删
```

**evict location**（清 warm 死驻留与事件噪声；2026-10-12 新增，2026-10-13 三订定位——evict **不防** location 请求建档，见 §3.4。debug 组端点，pin 含）：

```bash
# 盘点 warm 集合，挑出目录已删的
curl -s -u … http://127.0.0.1:15120/api/debug/location | jq -r '.[].directory'
# 逐个 evict（204 = 成功）；参数缺失会兜底到 server cwd，务必带全
curl -s -u … -X DELETE -G http://127.0.0.1:15120/api/debug/location \
  --data-urlencode "location[directory]=<已删目录>"
```

evict 只清 warm 死驻留与事件噪声，**不断再生**（再生源 = location 请求，见 §3.4）；已建的伪行仍按本节上式删。`POST /api/location/reload` 是 invalidate 全部后立即重建，不能当清除用。桌面端 `removeWorkspace` 已内建 evict（design-worktree-sync §3.4）；本节手动口径用于他端删除/外部 `rm -rf` 等漏 evict 场景的善后。

**location 请求触发建档（诊断式，§3.4 三订）**——两条命令确定性复现「一发请求一行」：

```bash
# ① 删一个 worktree（204，此刻无伪行）
curl -s -u … -X DELETE http://127.0.0.1:15120/api/worktree \
  -d '{"projectID":"<pid>","directory":"<worktree目录>","force":true}'
# ② 对死目录发一发带 location 的请求——伪行立即出现
curl -s -u … -G http://127.0.0.1:15120/api/vcs/diff \
  --data-urlencode "location[directory]=<worktree目录>" --data-urlencode "mode=working"
```

②的响应码随版本可能不同（实测 2.0.26 为 404；pin 的 openapi responses 无 404），**以「伪行立即出现」为判据**，勿以状态码论成败。验证「删行后不再生」时，须先确认客户端（桌面端 vcs 面板）已无对该目录的轮询。

### 5.3 验证方法（重要——字段名）

```bash
# 按 canonical 过滤（不是 worktree！）
curl -s -u … http://127.0.0.1:15120/api/project | jq '[.[] | select(.canonical | test("opencode/worktree|^/tmp|^/$"))] | length'
```

**再生实测**：删行后主动触发 `GET /api/project` + 等 60-120 秒再查。一次性为 0 不算数——server 扫描是异步的（burst 实测 1 行/秒持续 64 秒）。

## 6. 已知坑与边界

| 坑 | 说明 | 对策 |
| --- | --- | --- |
| **API 字段假阴性** | API 用 `canonical`，DB 列叫 `worktree`；过滤字段写错则「验证通过」是假的 | 一律按 `canonical` 过滤 |
| **`time_archived=0`** | v1 迁移 epoch 零值，`IS NULL` 条件漏掉；app 同样视 0 为未归档 | 条件写 `(IS NULL OR =0)` |
| **SQL 迁移竞态** | 运行中 server 内存态会用改库前的旧 directory 重新 upsert 旧伪行（实测迁移瞬间重建 7 行） | 迁移后观察一个扫描周期（几分钟）再收尾；客户端先断开更稳。**内存回写是一次性的**（proud-cactus 实证：凭空重建一次后不再生）——重删即断，无须重启 server |
| **project_directory 登记回写** | 死登记补刀删除后可能被内存态回写回来 | 回写**不触发行重建**（解析触发源才是关键，2026-09-30 实证）——行不再生即算断根，登记残留无害 |
| **PATCH 死目录会话 500** | `PATCH /api/session/:id`（D1 归档私约）会让 server realPath 会话目录，死目录直接 500 | 死目录会话只能 SQL 处置；用户裁定死目录不执行私约 |
| **删 project 级联删会话** | `session.project_id` 外键 CASCADE | 删行前必查挂载量；无处安放的会话先重指向（`global` 案例：11 重指向 + 74 级联删） |
| **server 重启 cwd 建档** | 重启解析 cwd（如 home 目录）→ 伪行复活 | 上游问题，删了治标；项目列表过滤已否决（§8 裁定），保留该行或接受其存在 |
| **双表镜像** | `session` 与 `session_v2` 数据互为镜像，只改一张会出现 API/扫描不一致 | 始终双表同步写 |
| **server 频繁自启** | 当日两次自行重启（19:33 / 20:36），疑与并发直写 DB 锁竞争有关 | 大事务前留意 `ps` 进程启动时间；必要时 `journalctl --user -u opencode-serve` 查因 |
| **location 请求建档** | 任何带 `location[directory]=<死目录>` 的请求（桌面端 vcs 轮询为代表）→ boot location → `project.resolve` → 目录哈希建档（§3.4 三订；根源 = `FSUtil.resolve` 对缺失路径回退原路径）。请求多 404 但行已建 | 客户端断请求源（删前停轮询，design-worktree-sync §3.5 待落）；evict/重启只治 warm 死驻留；治本 = 上游 resolve 失败不建档 + 回收（§8 上游 issue） |
| **日志只记非 2xx** | `Sent HTTP response` 仅落 4xx/5xx（实测 404/400/401/409，零 200/204）——成功的 DELETE/evict（204）在日志中**不可见** | 勿从「日志无此请求」推断「没调用过」；调用鉴证要看 `spawning process` 的 git/shell 痕迹或 DB 副作用（2026-10-13 实证：曾误判 evict 未被调用） |

## 7. 2026-09-29 实战记录（数字摘要）

- 首批删除 v1 迁移幽灵行 **116** 条；后续多轮再生-再清
- 归档死 worktree 孤儿会话 **1356+ 条**（含 `=0` 漏网补齐 22+27）
- 清理 `/tmp` canonical 项目 5 个、`/` 与 `/home/cyrasafia` 3 个（global 级联删 74 会话 + 11 重指向）
- 文档死目录迁移 5 条会话到新路径；qingjian 归档 1 条 + 删行
- `协作工作区`/`zl-ai` 旧路径孤儿 **237 条**全量迁移（17 组映射）
- 终态：项目表 53 行全部 canonical 磁盘存在；未归档会话全部挂活目录；`GET /api/project` 触发 + 120 秒零再生

## 7b. 2026-09-30 实战记录（worktree 开发测试善后）

**背景**：09-29 清理终态被打破——盘点 82 行、伪行约 40。燃料不是旧账复发，而是**清理之后新产生的**：worktree 分支挂载功能开发（09-29~30，design-worktree-branch-sync）建删测试 worktree 留下 18 个死目录伪行；`/tmp` 验证脚本产生 11 行（含 `final-verify-<ts>`——清理动作的验证本身成为燃料）；server 重启重建 cwd 行。

- 删伪行 **34** 条（82→50）：死 worktree 19 + `/tmp` 系 11 + cwd 1 + skills 1 + Agent-Engine 同路径伪行 1 + 内存回写 1
- 归档测试/调研会话 **13** 条（`/tmp` 系 9 + quiet-mountain 4，双表）；级联删挂伪行的测试会话 **10** 条
- 同路径双行重指向 **1** 条（Agent-Engine 伪行挂的真实会话 → 同路径 git 行，无损删行，见 §5.2）
- **quiet-mountain 剥洋葱**（§3.3 多层燃料实证来源）：归档 4 条会话→仍再生→补刀 `project_directory` 死登记 6 条→仍再生→清 opencode 项目 `sandboxes` 死条目→断根
- **proud-cactus**：DB 零引用凭空新建（内存态回写）→ 一次性，重删后不再生
- 文档目录 6 伪行**保留**（用户裁定：挂 13 条手机端真实工作会话，删行 = 级联物理删记录，归档也保不住；目录在磁盘上属设计内行为）
- 终态：50 行，worktree 类伪行双轮扫描零再生；cwd 行待 server 重启后复活（上游问题）
- **教训**：① worktree 功能测试是批量伪行源——测试用隔离 DB（`OPENCODE_DB`）别打生产库；② 清理验证脚本会把会话建在生产库，验证完同步清理自身；③ 「全都归档了」要用 SQL 复核，不要凭印象（本次复核出 8 条手机端未归档 + 文档目录活会话）

## 7c. 2026-10-12 实战记录（worktree 伪行复清与 warm location 定位）

**背景**：10-10 21:0x 完成清理（归档 7 个死 worktree 目录未归档会话 37 条双表、清 plan-travel `jolly-wolf` / openbuilder `calm-wolf` 两条 `sandboxes` 死条目、删 worktree 伪行 11 条与 `/tmp` 系 7 行 + `silent-island`，随行级联删 3 条 `busy-inbox-test` 测试会话），项目表 72→53，实测 80 秒零再生。**21:17 起 15 秒内 19 行原地重建**，10-11 又新增 4 条（brave-eagle、hidden-pixel、crisp-mountain、kind-otter），全部是已删 worktree 目录——项目表回到 76 行。

- 定位：§3.4 warm location 周期刷新。kind-otter 会话全归档、无 sandboxes/库存，燃料 1-3 全排除；`provider.updated` 293 次、5 分钟节律坐实。
- 处置：server 已于 10-12 14:10 重启，warm 集合随之清空（重启后 5 分钟刷新停止）。
- 记录时点终态：项目表 76 行，伪行 24 条（23 条本轮 warm location 再生 + `/home/cyrasafia` 保留行）；`skills` 2 条伪行已不在表；现存活 worktree 为 `342507/eager-moon`、`342507/shiny-tiger`（当日新建）与 `926230a…/happy-forest`、`…/shiny-orchid`，库存无 stale 行。
- 事后补：找到手动 evict 端点（§5.2；当日判「未文档化」系误查——实在 pin 内，见 §3.4 订正）并实测生效——`shiny-tiger` 当日删除后 location 未 evict（warm 集合仍含已删目录），evict 即消失，未及建档；当日自动化落地（design-worktree-sync §3.4：`removeWorkspace` 删除成功后 best-effort evict，原 todo-worktree-delete-location-evict 收编）。
- **2026-10-13 订正（当日三订终态）**：本节把再生归因于「warm location 5 分钟刷新重新解析建档」——已证伪；同晚实验**定位了触发器**：带 `location[directory]=<死目录>` 的请求（桌面端 vcs 轮询）→ boot location → resolve → 兜底建档，**一发一行**（§3.4、§7e）。21:17 批 = 删行后客户端对账对 19 个死目录串行各发一发。
- **教训**：① 「删行 + 归档会话 + 断客户端」不足以断根——真断法是**断请求源**：删除后没有带 `location[directory]` 的请求打向死目录（§3.4 三订；重启/evict 只清 warm 驻留，防不住请求建档）；② 复盘要趁热：server 日志滚动只留约一天，10-10 21:17 那批的触发现场已随滚动丢失，只能靠 10-11 的 kind-otter 反推；③ 桌面端持久化 Tab 里残留死 worktree 目录（glowing-engine、kind-lagoon）是下一轮的客户端侧燃料（燃料 4）；④ 机制归因要有实验支撑再落文档——「刷新即建档」从推断写成实证，一轮实验即翻。

## 7d. 2026-10-13 实战记录（evict 自动化后首批清理与观测）

**背景**：removeWorkspace 自动 evict 落地（design-worktree-sync §3.4）并随桌面端、手机端构建安装。存量待清：10-10/10-11 重建伪行 22 条（worktree 根 16 + `/tmp` 系 6；§7c 记的 23 条中 silent-island 已于当日先行处置）+ `/tmp` 测试产物 2 条（`vcs-bench`、`ob-review-fake-probe-xyz`）。

- 清理 **24** 条：worktree 根伪行 16 + `/tmp` 系 8（`difftest`、revtest 三件套、bigtest、`/tmp/opencode`、vcs-bench、probe-xyz）；`/tmp/opencode` 挂的 13 条已归档 probe 测试会话随行级联删。
- 同日另处置同路径双行 anything（§3.5）：v1 23 条重指向新身份行后删老行，钉住文件 `.git/opencode` 与客户端持久化老 id 同步更新。
- 观测：每 60 秒采样 DB/API 行数、伪指纹行数、warm 集合目录存活，**16 分钟（≥3 个刷新周期）全零**——行数稳定 54、伪行 0（§5.3 正则口径，不含 `/home/cyrasafia` 保留行）、warm GONE 0。
- **结论（三订后）**：「自动 evict + 清存量」后删行零再生（16 分钟观测）——当晚定位真触发器（§3.4：location 请求 → resolve → 建档）后回看，本批零再生的实际原因是**删除后没有带 location 的请求打向死目录**，evict 并非决定因素（只治 warm 死驻留）。剩余再生风险 = 删除后有 location 请求落向死目录（vcs 轮询在途/事件触发），预防方案待落 design-worktree-sync §3.5。

## 7e. 2026-10-13 实验记录（机制三订：定位触发器 = location 请求；内含二订→三订全程）

**背景**：neon-wizard 伪行建于删除同秒（17:20:23，app 驱动删除、location 热）。为定位触发器，当晚做受控实验（本机 server 2.0.26，`race-probe-*` 系列探针：隔离、并发、warm、shell 时序、官方 GUI 对照多组）。

- **隔离实验（location 冷）**：仅 `DELETE /api/worktree`；仅 evict / 仅 `GET /api/project` / 仅 `GET /api/worktree` / 仅 `POST refresh`；删除 + 上述并发组合 ×3——**全部零建行**。
- **shell 清理隔离（×2，location 冷）**：A = 挂分支（`POST /api/shell` `git switch -c`）→ DELETE → shell show-ref + `branch -D`；B = 完整 removeWorkspace 时序（挂分支 → DELETE → evict → `GET /api/project` → `GET /api/worktree` → shell ×2）——**均零建行**。客户端删除时序至此洗清（指调用序列本身，location 冷、无 vcs 轮询在跑；真实会话中 vcs 轮询仍是触发源，见 §3.4）：与调用序列无关，官方 GUI 的「零对账」与本端的「全对账」同样安全。
- **官方 GUI 时序对照**（`packages/app/src/pages/layout.tsx:1377` deleteWorkspace，HEAD 源码）：删后 **零 server 调用**——`serverSync().set("project")` 本地乐观滤掉 sandboxes、workspaceOrder/布局本地更新；**不做**会话级联删（恰好留燃料 1）、不做分支清理（不挂分支）、不重拉。仅作时序参照，不照搬。
- **偶发性佐证（二订口径，已作废——见下「推论订正」）**：同日（10-13）经同一流程删除的 quick-circuit **未**产生伪行，neon-wizard 中招——当时归因为半删窗口碰撞的概率事件。
- **warm 受控实验**：探针建好 → 桌面端真实切进（warm 确认 + entries/AGENTS.md watcher 挂上）→ API 直删。结果：
  - 删除瞬间 location **重建**（config/provider/model/command/agent 事件连发）——**无建行**；
  - 死目录 location **驻留 warm ≥10 分钟**不退（无 evict 时）；**5 分钟刷新照常触发**（事件 +2）——**仍无建行**；
  - 收尾 evict（204）后 warm 清零。
- **推论（二订口径，已作废——见「推论订正」）**：行只能由 `projects.resolve` 在「realpath 可达但 git 解析失败」的目录状态下产生；目录**彻底消失后 resolve 提前失败、不建档**。可建行的唯一窗口是删除过程的**半删态**（目录在、`.git` 已没）——亚秒级 + 须恰有并发 resolve，故各轮探针零复现；21:17 批与 neon-wizard 的具体触发器**未定位**（现场日志已滚动）。
- **源码锚（v2.0.18 tag；运行版 2.0.26 未逐行核对）**：`Worktree.remove` 链路（strategy.remove → ops.remove → 发事件）**不调 `projects.resolve`**——core 内调用方仅 session 创建/移动/转移三处；唯一确定的 resolve 点 = **location（重）建**（`core/src/location.ts:24`：`project.resolve(ref.directory)`）；SSE 全局单流纯下行，事件发布链不触发 resolve；watcher 消费者（`vcs.ts:151` 只刷分支、config/AGENTS.md 热重载）亦不 resolve。与「触发器未定位」自洽：候选只剩 location 重建与 session 三处，且须恰好落在半删窗口。
- **对上游 issue 的影响**：主张不变（upsert-only 无回收 = 行删了会回来/永久残留，铁的事实；「删一个 worktree 反而制造伪行」有实证），但证据链从「机制明确」降级为「现象确凿、触发器未定位」——issue 措辞按此写。
- **教训**：归因要有受控实验支撑；本次若非实验，错误机制会一路带进上游 issue。
- **最终复现（三订，race-probe-vcs）**：读 v2.0.24 源码发现两处关键事实——① 所有带 `location[directory]` 的请求经 location 中间件按需 boot → `project.resolve(目录)`；② `FSUtil.resolve` 对缺失路径**回退原路径**（`util/fs-util.ts:105-111`）。据此重测：DELETE worktree → 对死目录发 `GET /api/vcs/diff?location[directory]=…`（404）→ **伪行立即出现**。确定性复现，一发一行。
- **推论订正**：「半删窗口」推论作废——不需要窗口，彻底删除后照样建档；warm/刷新/时机全部无关，唯一条件是「有请求带着该目录的 location 参数打过来」。此前各轮探针零复现的原因：仅 evict / `GET /api/project` / `GET /api/worktree` / `POST refresh` 及其并发组合**均不带 location 参数**（boot 的是 server cwd）、一发带 location 的 session 调用未实际执行成功、warm 实验后未再发过 location 请求——**触发条件从未被打中**。
- **客户端可防（待落 design-worktree-sync §3.5）**：删前停 vcs 轮询 + 等 in-flight location 请求；evict/重启防不住本机制（请求会 re-boot location）。上一条「对上游 issue 的影响」中「触发器未定位」一句随之作废——issue 可按确定性机制写。

## 8. 客户端可防御点（与 openbuilder TODO 方向 2 的关系）

服务端无回收机制（上游 issue 待提）。展示层兜底逐项裁定如下：

- **项目列表过滤：否决**（2026-10-12 用户裁定）——按 §1 指纹过滤易误伤（活 worktree 目录、空壳残渣、未来上游语义变化都可能撞指纹），且病根在 server upsert-only 无回收，**属上游问题**；不作为本端修复项。保留 SQL 手工清理（§5）+ 上游 issue 跟进
- 会话列表：死目录分组渲染前先判目录（或「工作区已删除」态）
- worktree 列表：对「存在但无 `.git`」的空壳提示走服务端清理（rm + refresh）
- **删 worktree 时同步卸载该目录全部引用**（关闭该目录 Tab/作用域、清持久化记忆——断本端燃料 4）**+ 删除成功后显式 evict location**（桌面端 2026-10-12 落地，design-worktree-sync §3.4）——「卸载引用 → location 自动 evict」因果链为推断且从未实证，显式 evict 才是确定断法
- 归档识别：`time.archived != 0`（勿只判非空/非 NULL）
