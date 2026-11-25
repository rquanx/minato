# LiteLLM 全量能力迁移策略

## 目标

Minato 的目标仍然是覆盖 LiteLLM Proxy 的完整公开能力。Go 重写的重点是推理数据平面中长期驻留、请求量大、对延迟和内存敏感的部分。长尾管理接口、低频 provider 适配器和 LiteLLM Web UI 使用兼容层承接，避免为了少量请求把 Python 代码重复翻译到 Go。

“全部迁移”指对业务可用能力提供统一的 Minato 接口和部署方式。内部实现允许在 Go、本地 LiteLLM 兼容进程或静态前端之间分层。

## 三层实现

### Go 核心数据平面

由 `litellm-go` 提供。Minato 通过通用配置关闭所用部署的管理 API 和扩展供应商 API，并启用路由发布接口。

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

兼容层固定使用 LiteLLM `v1.85.0`。管理员将它登记为模型来源，通过目录、功能点候选和环境默认池决定适用的兼容模型。启用混合部署后，Python 服务常驻，多个 Go 实例可以共用一个兼容服务。

### LiteLLM Web UI 静态资源

LiteLLM Dashboard 使用原版 Next.js 静态导出，当前镜像中的构建目录约 21 MiB。`compose.hybrid-ui.yaml` 通过 Caddy 提供静态资源，登录和管理 API 由同源代理转发到 Python LiteLLM。

## 请求选择

1. 发布时，Minato 根据目录中的模型能力，把符合条件的直连模型和 LiteLLM 兼容模型编入同一份路由快照。
2. Go Runtime 按候选顺序调用。首选收到 429 等可重试错误时，可切换到 Python 候选。流式响应开始输出后，当前请求沿用已选候选。
3. Minato 接收 Go 返回的尝试记录，用同一业务请求 ID 关联模型、用量和审计，并按 Minato 中配置的模型价格估算成本。
4. 来源停用或目录确认模型下架后，Minato 根据已发布的策略重算候选。环境默认池中的兼容模型可自动成为新首选。

## 内存与部署

推荐默认部署只有 Minato、Go Runtime 和 PostgreSQL。兼容层按需启动，可以单独部署在同一主机、Railway 私有服务、阿里云或本地网络中。需要完整 LiteLLM 能力时，增加一个兼容层副本，不改变业务方的注册 ID 和预设模型。

Go Runtime 的内存基线继续独立测量。兼容层的 Python 内存只计入启用兼容能力的部署，不把它作为所有实例的固定成本。

仓库提供 `compose.hybrid.yaml` 和可选的 Dashboard 覆盖文件。混合部署复用 Python 服务的原生 API。Minato 统一入口当前覆盖其现有推理接口，管理接口和其他 LiteLLM API 由兼容服务分别提供。 [部署说明](self-host.md#hybrid-data-plane)

## 迁移顺序

1. 为每个 LiteLLM route 和 provider 标记 `go`、`compat` 或 `both`。
2. 高频路径先达到 Go 与 Python fixture 一致，再切换默认实现为 Go。
3. 长尾路径先接入兼容层，建立统一审计、用量和错误映射。
4. 当某个 compat 能力的调用量、内存和维护成本足够高时，再迁移到 Go。
5. 每次 LiteLLM 版本升级先更新兼容层镜像，再运行 route inventory 和行为 fixture，最后按模块迁移 Go 实现。

## 边界

LiteLLM 的 MIT 目录可以在遵守许可证和保留版权声明的前提下作为兼容层来源。`enterprise/` 目录不纳入复制范围。LiteLLM UI 只复用其公开静态构建和 API 约定，Minato 自有页面与业务数据仍由 Minato 控制。
