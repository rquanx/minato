# Minato MVP Tickets

以下任务从 [MVP 实施计划](../roadmap.md) 拆分。每张 ticket 列出直接依赖、交付范围和可复现的验收条件。依赖完成后即可开始，表内顺序用于同一阶段的阅读和安排。M2 和 M3 在 M1 验收后可并行。

## M1 本地推理链路

| Ticket | 直接依赖 | 状态 |
| --- | --- | --- |
| [MIN-001 初始化开发环境](MIN-001-workspace.md) | 已完成的 LiteLLM 本地验证 | 已实现 |
| [MIN-002 项目环境与凭证](MIN-002-project-auth.md) | [MIN-001](MIN-001-workspace.md) | 已实现 |
| [MIN-003 登记功能点与固定别名](MIN-003-feature-registration.md) | [MIN-002](MIN-002-project-auth.md) | 已实现 |
| [MIN-004 静态候选发布与回滚](MIN-004-route-publication.md) | [MIN-003](MIN-003-feature-registration.md) | 已实现 |
| [MIN-005 推理入口与有序回退](MIN-005-inference.md) | [MIN-004](MIN-004-route-publication.md) | 已实现 |
| [MIN-006 流式透传与取消](MIN-006-streaming.md) | [MIN-005](MIN-005-inference.md) | 已实现 |
| [MIN-007 本地端到端演示](MIN-007-local-demo.md) | [MIN-006](MIN-006-streaming.md) | 已实现 |

## M2 目录同步与动态路由

| Ticket | 直接依赖 | 状态 |
| --- | --- | --- |
| [MIN-008 来源管理与模型目录](MIN-008-catalog-sync.md) | [MIN-007](MIN-007-local-demo.md) | 已实现 |
| [MIN-009 能力匹配与路由预览](MIN-009-route-policy.md) | [MIN-008](MIN-008-catalog-sync.md) | 已实现 |
| [MIN-010 目录变更后的自动发布](MIN-010-route-reconciliation.md) | [MIN-009](MIN-009-route-policy.md) | 已实现 |

## M3 用量与调用审计

| Ticket | 直接依赖 | 状态 |
| --- | --- | --- |
| [MIN-011 调用与尝试事件持久化](MIN-011-call-events.md) | [MIN-007](MIN-007-local-demo.md) | 已实现 |
| [MIN-012 用量查询与统计](MIN-012-usage-reporting.md) | [MIN-011](MIN-011-call-events.md) | 已实现 |
| [MIN-013 请求及响应正文审计](MIN-013-audit-content.md) | [MIN-011](MIN-011-call-events.md) | 已实现 |

## M4 管理界面与单次测试

| Ticket | 直接依赖 | 状态 |
| --- | --- | --- |
| [MIN-014 项目环境与路由控制台](MIN-014-routing-console.md) | [MIN-010](MIN-010-route-reconciliation.md) | 已实现 |
| [MIN-015 用量、调用详情与 Prompt 复制](MIN-015-call-console.md) | [MIN-012](MIN-012-usage-reporting.md)、[MIN-013](MIN-013-audit-content.md)、[MIN-014](MIN-014-routing-console.md) | 已实现 |
| [MIN-016 单次测试与回放执行](MIN-016-replay-execution.md) | [MIN-010](MIN-010-route-reconciliation.md)、[MIN-012](MIN-012-usage-reporting.md)、[MIN-013](MIN-013-audit-content.md) | 已实现 |
| [MIN-017 测试编辑器与结果对比](MIN-017-replay-console.md) | [MIN-015](MIN-015-call-console.md)、[MIN-016](MIN-016-replay-execution.md) | 已实现 |

## M5 自托管发布

| Ticket | 直接依赖 | 状态 |
| --- | --- | --- |
| [MIN-018 验证真实上游兼容性](MIN-018-provider-acceptance.md) | [MIN-010](MIN-010-route-reconciliation.md)、[MIN-012](MIN-012-usage-reporting.md)、[MIN-013](MIN-013-audit-content.md) | 已实现 |
| [MIN-019 自托管安装与发布验收](MIN-019-self-host-release.md) | [MIN-017](MIN-017-replay-console.md)、[MIN-018](MIN-018-provider-acceptance.md) | 已实现 |

批量回放、评测集和发布门禁沿用路线图中的 MVP 之后范围。

