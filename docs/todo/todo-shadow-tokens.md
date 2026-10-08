# 阴影黑收敛令牌 — 待办（todo-shadow-tokens）

> 类型：todo（暂时不做、未来另开分支实施的工作项记录；与 plan 的区别见
> AGENTS.md 文档分类——plan 是即将实施的较大改动的分步执行计划）。
> 来源：2026-10-08 用色审计（全量扫描 app.css hex/rgba 字面量，随卡片族样式对齐触发）。
> 结论：主体用色已走 token；阴影黑 alpha 共 4 处声明（5 个 rgba 值）未令牌化。
> 性质：非违规——浮层阴影用黑 alpha 是通用惯例，DESIGN.md 未要求；本文记档待办，
> 不阻塞任何功能。

## 现状清单（app.css，选择器定位，行号会漂移）

| 选择器 | 现值 | 场景 |
|---|---|---|
| `.popover` | `0 6px 24px rgba(0,0,0,0.4)` | 通用浮层（最重档） |
| `.command-hints` | `0 4px 16px rgba(0,0,0,0.25)` | 斜杠命令菜单（中档） |
| `.md-toc` | `0 2px 12px rgba(0,0,0,0.18)` | markdown TOC 悬浮窗（轻档） |
| `.welcome-card` | `0 8px 28px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.18)` | 引导页卡片（双层双档） |

不在范围：`.dialog-mask`（0.5）/ `.dialog-mask.image-zoom`（0.78）为遮罩黑，
DESIGN.md 明文豁免；terminal 族 hex 为「恒深色不接 data-theme」决策，另行在案。

## 方案草案

1. **令牌组**（tokens.css 单点，深浅主题同值——阴影黑不随主题翻转，与遮罩同惯例）：
   - `--shadow-overlay`：浮层最重档（现 `.popover` 值）
   - `--shadow-popout`：菜单/悬浮窗中档（现 `.command-hints` 值）
   - `--shadow-float`：轻悬浮档（现 `.md-toc` 值）
   - `--shadow-card`：双层卡片段（现 `.welcome-card` 值）
2. **落点原则**：按「场景档位」而非裸 alpha 建令牌——五处档位本就不同
   （0.18/0.24/0.25/0.4），收敛成单一 alpha 会改观感；先原值搬进 token，
   合并档位（0.24/0.25 是否并档）留实施时按视觉实测裁定。
3. **验收**：四处 box-shadow 全部 `var()` 消费，grep app.css 无
   `box-shadow:.*rgba` 残留；深浅主题截图对比无变化；DESIGN.md 组件章
   补一条阴影令牌说明（含「阴影黑不随主题翻转」依据）。
