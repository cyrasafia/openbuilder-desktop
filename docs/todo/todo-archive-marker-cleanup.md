# 归档私约残留清理（todo-archive-marker-cleanup）

> 状态：待办（暂不做，实施时另开分支）。来源：design-archive-official-api 迁回实施（2026-10-25）的终态收敛项。

## 背景

归档已迁回官方 API（design-archive-official-api）。过渡期保留的双源识别与私约回退路径，在触发条件满足后应整体移除。

## 清理项

1. **双源识别收敛单源**：`src/shared/v2-adapter.ts` 的 `isArchivedSession` / `archivedAtOf` 去掉 `metadata.archivedAt` 源（只认 `time.archived`）。
2. **私约写路径删除**：`src/renderer/src/store/app-store.ts` `patchSessionArchive` 的 <2.1.3 回退分支与 `archiveApiReady` 分派（随 server 版本下限升至 2.1.3 一并做——`MIN_SERVER_VERSION_V2` 升级时旧 server 本就连不上，回退分支成死代码）。
3. **`session.metadata.updated` 接线收窄**：该 case 保留是为兼容其他机器上的旧版桌面端写 marker；marker 集合 drained 后可移除归档相关消费（事件本身仍服务 rename 以外的 metadata 更新，按需保留）。
4. **测试清理**：app-store.test.ts 的 D1 私约 describe 与「版本分派回退」用例随实现删除。

## 触发条件（两者满足其一即可评估）

- 存量 marker 集合 confirmed drained（本端与 openbuilder 双端 backfill 均扫空——观察 `GET /api/session` 全量无 `metadata.archivedAt` 键）
- `MIN_SERVER_VERSION_V2` 升至 2.1.3+（下限淘汰旧 server，回退分支必然死代码）

## 不做的部分

- 对 v1 存量 `time.archived` 的清理（官方字段，无需动）
- `?archived=` 过滤参数消费（读路径维持全量拉取，design-archive-official-api §5——与本次清理无关）
