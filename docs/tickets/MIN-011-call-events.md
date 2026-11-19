# MIN-011 调用与尝试事件持久化

里程碑为 M3 用量与调用审计。 [Ticket 索引](README.md)

直接依赖 [MIN-007](MIN-007-local-demo.md)。 [相关设计](../implementation/audit-replay.md)

## 交付范围

- 持久化入口事件和 LiteLLM 回调，以尝试 ID 对账并标记缺失与失败。

## 验收条件

- [x] 重复、乱序事件只形成一条业务调用和各自独立的尝试记录。
- [x] 采集链路异常可观察，推理响应能继续返回。

