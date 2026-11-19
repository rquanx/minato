# MIN-007 本地端到端演示

里程碑为 M1 本地推理链路。 [Ticket 索引](README.md)

直接依赖 [MIN-006](MIN-006-streaming.md)。 [相关设计](../implementation/delivery.md)

## 交付范围

- 编写从空数据库开始的示例与回归脚本，串联创建项目、发 Key、登记、发布、调用、撤销和回滚。

## 验收条件

- [x] 标准 OpenAI SDK 分别完成 Chat 与 Responses 调用。限流回退、普通参数错误和撤销都可复现。
- [x] 在途请求使用旧候选，新请求使用新候选，回滚后新请求恢复上一策略。

