# MIN-015 用量、调用详情与 Prompt 复制

里程碑为 M4 管理界面与单次测试。 [Ticket 索引](README.md)

直接依赖 [MIN-012](MIN-012-usage-reporting.md)、[MIN-013](MIN-013-audit-content.md)、[MIN-014](MIN-014-routing-console.md)。 [相关设计](../implementation/audit-replay.md)

## 交付范围

- 提供用量筛选、调用列表和详情，串联尝试时间线及请求响应正文。支持复制单条消息、完整 Prompt 和请求 JSON。

## 验收条件

- [x] 从用量筛选可跳转到对应调用。详情显示回退原因、已知 token 及正文采集状态。
- [x] 复制保留消息角色与顺序，外发内容过滤凭证并提示脱敏或截断。

