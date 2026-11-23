# LiteLLM 全量能力迁移策略

## 目标

Minato 的目标仍然是覆盖 LiteLLM Proxy 的完整公开能力。Go 重写的重点是推理数据平面中长期驻留、请求量大、对延迟和内存敏感的部分。长尾管理接口、低频 provider 适配器和 LiteLLM Web UI 使用兼容层承接，避免为了少量请求把 Python 代码重复翻译到 Go。

“全部迁移”指对业务可用能力提供统一的 Minato 接口和部署方式。内部实现允许在 Go、本地 LiteLLM 兼容进程或静态前端之间分层。

## 三层实现

### Go 核心数据平面

固定放入 `minato-runtime`，保证常驻内存和延迟。

- OpenAI、Responses、Chat Completions、Anthropic、Gemini 的常用协议转换
- 路由、回退、重试、限流、健康检查和模型选择
- Key、项目范围、策略和 guardrail 的请求前检查
- 流式转发、缓存、token 与成本统计、调用尝试记录
- CPA、OpenCode、兼容网关及 OpenAI-compatible 来源
- 高频文件、批量、Embedding、RAG 和 Realtime 路径中已经验证的部分

### LiteLLM Python 兼容层

作为可选的独立进程或独立容器运行。Go 通过内部 OpenAI-compatible 请求或专用适配接口调用它。

- 尚未完成 Go 适配的长尾 provider
- 低频管理接口和临时兼容接口
- Python 专属 tokenizer、格式转换和实验性 API
- 迁移期间需要与 LiteLLM 原始行为逐项对照的能力

兼容层使用固定的上游版本，首个基线为 LiteLLM `v1.85.0`。它不参与默认 Go 请求的常规路径，只有路由明确指定兼容能力或 Go 能力检查失败时才被选择。这样保留完整覆盖，同时避免每个 Minato 实例常驻 Python 内存。

### LiteLLM Web UI 静态资源

LiteLLM Dashboard 是 Next.js 静态导出，当前镜像中的构建目录约 21 MB。它可以由 Go Runtime、Caddy 或独立静态容器提供。静态资源不会产生 Python 常驻内存，但 UI 使用的 API 需要 Minato 提供 LiteLLM 兼容端点，或在兼容模式下指向 LiteLLM 管理层。

## 请求选择

1. Minato 根据功能点、模型能力和发布版本选择 Go Runtime。
2. Go Runtime 判断 provider、endpoint 和请求能力是否已覆盖。
3. 已覆盖的请求直接由 Go 执行。
4. 未覆盖但已登记兼容能力的请求转到 LiteLLM 兼容层。
5. Go 和 Python 均返回统一的 request ID、attempt ID、model、provider、usage 和 cost 事件。
6. 对同一请求不在两个数据平面之间无界重试。只有请求尚未向上游写出，且错误被标记为可迁移时才允许切换。

## 内存与部署

推荐默认部署只有 Minato、Go Runtime 和 PostgreSQL。兼容层按需启动，可以单独部署在同一主机、Railway 私有服务、阿里云或本地网络中。需要完整 LiteLLM 能力时，增加一个兼容层副本，不改变业务方的注册 ID 和预设模型。

Go Runtime 的内存基线继续独立测量。兼容层的 Python 内存只计入启用兼容能力的部署，不把它作为所有实例的固定成本。

## 迁移顺序

1. 为每个 LiteLLM route 和 provider 标记 `go`、`compat` 或 `both`。
2. 高频路径先达到 Go 与 Python fixture 一致，再切换默认实现为 Go。
3. 长尾路径先接入兼容层，建立统一审计、用量和错误映射。
4. 当某个 compat 能力的调用量、内存和维护成本足够高时，再迁移到 Go。
5. 每次 LiteLLM 版本升级先更新兼容层镜像，再运行 route inventory 和行为 fixture，最后按模块迁移 Go 实现。

## 边界

LiteLLM 的 MIT 目录可以在遵守许可证和保留版权声明的前提下作为兼容层来源。`enterprise/` 目录不纳入复制范围。LiteLLM UI 只复用其公开静态构建和 API 约定，Minato 自有页面与业务数据仍由 Minato 控制。
