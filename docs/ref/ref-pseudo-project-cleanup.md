# ref: 伪项目（pseudo project）成因与清理方法

> 性质：参考资料（数据中心运维手册）｜ 首版：2026-09-29，基于当日 v2.0.18 server（端口 15120）全量清理实战｜ 2026-09-30 增补：燃料模型实证（§3.3）、顽固行剥洋葱（§5.2）、worktree 开发测试善后实录（§7b）｜ 2026-10-12 增补：warm location 周期刷新燃料与 evict 端点（§3.4/§5.2）、当日实战（§7c）、项目列表过滤裁定否决（§8）、自动化待办（todo-worktree-delete-location-evict）
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
6. **server warm location 周期刷新**（§3.4，2026-10-12 实证）——已删 worktree 目录的 location 留在 server 内存，每 5 分钟刷新时重新解析 → 兜底建档。**与燃料 1-3 正交**：会话全归档、sandboxes/库存干净也拦不住；只有 server 重启或 location evict 能断

**燃料灭则火灭**：归档全部未归档会话 + 客户端断开后，删行实测 60-120 秒零再生（燃料 1-5 口径；若命中燃料 6 须按 §3.4 另断——归档会话与断客户端都无效）。

**单行可穿多层燃料**：quiet-mountain 依次穿透 1→3→2 三层才断根（归档 4 条会话→仍再生→补刀 6 条库存登记→仍再生→清 sandboxes 死条目→断根）。顽固行按 §5.2 剥洋葱处理，每剥一层删行重验。

**归档判定陷阱**：未归档 = `time_archived IS NULL` **或 `time_archived = 0`**。v1 迁移产生大量 epoch 零值（`0` 非 NULL），按 `IS NULL` 归档会漏——漏网的恰好是手机端渲染出来、且持续再生的那批。app 侧判定同源：`time.archived != 0` 才算归档（openbuilder `models.dart`）。

### 3.4 warm location 周期刷新（燃料 6，2026-10-12 实证）

**机制**：客户端把某目录作为 location 打开后，server 在内存保留该 location（warm）。worktree 目录随后被删除时，location **不随目录消失**，留在 warm 集合里；server 周期刷新每个 warm location 的 provider/model（实测 **5 分钟一次**），刷新即重新解析目录。目录已不存在 → `Worktree.DirectoryUnavailableError` → 走 §3.1 兜底建档，upsert 伪行。

**证据（kind-otter）**：目录 2 条会话全归档、无 sandboxes 条目、无库存行——燃料 1/2/3 全断，行仍持续再生。日志 293 次 `provider.updated`，时间戳整齐间隔 5 分钟，自 2026-10-11 05:47Z 至 10-12 08:37Z 约 27 小时；窗口内**无**该目录的 `location services booted`，即早在窗口前已 boot、此后从未 evict。

**断根口径**：

- **手动 evict（首选，已实测生效）**：`GET /api/debug/location` 盘点 warm 集合 →
  `DELETE /api/debug/location?location[directory]=<绝对路径>` 逐个 evict（204）。
  v2.0.18 **未文档化** debug 端点（`server/src/handlers/debug.ts`），升级需回归；
  取参兜底是 `process.cwd()`，**绝不可不带参数裸调**。自动化落地见
  todo-worktree-delete-location-evict。
- **server 重启即清** warm 集合：2026-10-12 14:10 重启后，kind-otter 的 5 分钟刷新立即停止（仅剩 1 次由扫描触发）。
- **SQL 删行治标**：warm location 下一次刷新即原地重建。10-10 21:17 实测：删行后 15 秒内约 1 行/秒重建 19 行。
- **客户端侧**：worktree 删除须同步卸载该目录全部引用（Tab/作用域/持久化记忆），location 才会 evict——见 §8 裁定。「卸载引用 → evict」因果链为推断，未单独实证：缺一次经客户端 removeWorktree 删除后观察 5 分钟节律是否停止的实测。若该链成立，10-10 经客户端删除的 worktree 不该复燃——除非那批是 SQL/rm -rf 删除、未经客户端路径。
- **判别口径**：某死目录伪行反复再生、但会话全归档且 sandboxes/库存干净时，先查 `provider.updated`/`model.updated` 是否周期性落在该目录，不必再剥会话/库存：
  `grep 'provider.updated' ~/.local/share/opencode/log/opencode.log | grep '<slug>' | grep -oE 'timestamp=[^ ]+'`
  时间戳呈 5 分钟节律即坐实。server 日志滚动只保留约一天，复盘要趁热。

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

**evict location**（断 §3.4 燃料 6；2026-10-12 新增，端点未文档化）：

```bash
# 盘点 warm 集合，挑出目录已删的
curl -s -u … http://127.0.0.1:15120/api/debug/location | jq -r '.[].directory'
# 逐个 evict（204 = 成功）；参数缺失会兜底到 server cwd，务必带全
curl -s -u … -X DELETE -G http://127.0.0.1:15120/api/debug/location \
  --data-urlencode "location[directory]=<已删目录>"
```

evict 只断「再生」；已建的伪行仍按本节上式删。`POST /api/location/reload` 是
invalidate 全部后立即重建，不能当清除用。

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
| **warm location 保活** | 已删 worktree 的 location 留在 server 内存，每 5 分钟刷新即重新解析 → 兜底建档（§3.4）。SQL 删行治标，下轮刷新原地重建（10-10 实测 15 秒重建 19 行） | server 重启即清；治本 = 客户端删 worktree 时卸载该目录引用（§8）+ 上游补回收（§8 待办） |

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
- 事后补：找到手动 evict 端点（§5.2，未文档化）并实测生效——`shiny-tiger` 当日删除后 location 未 evict（warm 集合仍含已删目录），evict 即消失，未及建档；自动化落地记 todo-worktree-delete-location-evict。
- **教训**：① 「删行 + 归档会话 + 断客户端」不足以断根——命中 warm location 必须等 server 重启或 location evict，删行只是等待窗口；② 复盘要趁热：server 日志滚动只留约一天，10-10 21:17 那批的触发现场已随滚动丢失，只能靠 10-11 的 kind-otter 反推；③ 桌面端持久化 Tab 里残留死 worktree 目录（glowing-engine、kind-lagoon）是下一轮的客户端侧燃料（燃料 4）。

## 8. 客户端可防御点（与 openbuilder TODO 方向 2 的关系）

服务端无回收机制（上游 issue 待提）。展示层兜底逐项裁定如下：

- **项目列表过滤：否决**（2026-10-12 用户裁定）——按 §1 指纹过滤易误伤（活 worktree 目录、空壳残渣、未来上游语义变化都可能撞指纹），且病根在 server upsert-only 无回收，**属上游问题**；不作为本端修复项。保留 SQL 手工清理（§5）+ 上游 issue 跟进
- 会话列表：死目录分组渲染前先判目录（或「工作区已删除」态）
- worktree 列表：对「存在但无 `.git`」的空壳提示走服务端清理（rm + refresh）
- **删 worktree 时同步卸载该目录全部引用**（关闭该目录 Tab/作用域、清持久化记忆）——location 才会 evict，warm location 燃料（§3.4）随之断；2026-10-12 新增要点
- 归档识别：`time.archived != 0`（勿只判非空/非 NULL）
