# v0.6 功能范围（进行中）

主题：**v2 新能力消费**——server ≥2.0.23 的契约增量落地（design-v2-migration 附录 A1 起步）。v0.5 的功能面全量保留；本文档随功能落地逐项补全。

## 前提

- server 版本：**推荐 ≥2.0.23**（credential 删除端点 2.0.23 起；列表/设置 key 2.0.18 起可用，详见各功能的版本注记）。连接低版本 server 仅受 `serverVersionWarning` 提示，不做硬拦截（沿用 v0.5 口径）。

## 范围内

| # | 功能 | 说明 | 状态 |
|---|------|------|------|
| 1 | **Provider 页签恢复**（design-provider-config v2 重写） | 设置弹窗恢复 Provider 页签（连接与模型之间）：列表 = `GET /api/integration` connections 非空项（一行一条 connection：key/oauth 凭据 + env 只读）；设置/更换 key = `POST /api/integration/:id/connect/key`（新凭据自动激活）+ 清理旧凭据 `DELETE /api/credential/:id`（两段式）；删除凭据走同 DELETE（二次确认）；needs_auth 警示徽标；模型数列复用 modelCatalogs 缓存。沿用 v1 决策：仅已配置项、无发现入口、明文面为零（不调 `GET /api/credential`）。删除/清理在 2.0.18–22 server 上 404（错误内联呈现，不做版本分支） | ✅ 已落地（2026-10-06） |

## 范围外（明确不做）

- OAuth/浏览器登录流（`connect/oauth` + `connect/command` 端点已在契约，按需另行 design）
- 新增 integration 发现入口（全目录 229 项平铺，v1 2026-09-23 弃用决策沿用）
- 凭据多选管理（label 改名 `PATCH /api/credential/:id`、activate 切换——单槽语义已由 connect/key + DELETE 组合覆盖）

## 验收口径

- [x] Provider 页签：已配置 integration 列表渲染（method 徽标/凭据 label/模型数/needs_auth 警示）；`npm run test`/`typecheck` 全绿
- [x] 更换 key：connect/key 成功 → 旧凭据清理 → 列表重拉收敛为单行（活体 curl 三端点 round-trip 已验；App 内走查待用户执行）
- [ ] 删除凭据：二次确认后行消失，重连后不复活（server 侧凭据全局存储）
- [ ] 2.0.18 server（如需另起端口）：列表与设置 key 可用，删除报 404 错误内联呈现
