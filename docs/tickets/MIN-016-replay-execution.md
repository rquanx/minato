# MIN-016 单次测试与回放执行

里程碑为 M4 管理界面与单次测试。 [Ticket 索引](README.md)

直接依赖 [MIN-010](MIN-010-route-reconciliation.md)、[MIN-012](MIN-012-usage-reporting.md)、[MIN-013](MIN-013-audit-content.md)。 [相关设计](../implementation/audit-replay.md)

## 交付范围

- 实现测试提交、异步执行和结果查询。支持新建请求和从历史调用载入，按当前路由或指定兼容模型执行。

## 验收条件

- [x] 重复幂等键只执行一次。回放验证环境权限，记录原请求和新的请求 ID。
- [x] 远程上下文缺失时提示补齐。如无法确认请求是否送达则标为未知，等待对账。

