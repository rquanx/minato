# MIN-001 初始化开发环境

里程碑为 M1 本地推理链路。 [Ticket 索引](README.md)

直接依赖 已完成的 LiteLLM 本地验证。 [相关设计](../implementation/delivery.md) · [本地验证](../../tools/litellm-compat/README.md)

## 交付范围

- 初始化 TypeScript workspace、服务启动入口和 Postgres 迁移。接入现有 LiteLLM 和模拟上游。

## 验收条件

- [x] 空库可按仓库命令启动。重复应用迁移后结构一致。
- [x] 本地就绪检查能区分数据库或 LiteLLM 未就绪。

