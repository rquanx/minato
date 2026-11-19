# LiteLLM 本地兼容性验证

本验证固定使用官方 LiteLLM `v1.85.0` 镜像摘要和本机已有的 `postgres:17-alpine`。容器连接隔离网络，模拟两个上游，未配置真实模型凭证。Postgres 使用临时存储。

在本目录运行以下命令。Compose 配置复用本地镜像。

```sh
docker compose -p minato-litellm-check up -d --pull never --no-build
docker compose -p minato-litellm-check exec -T fixture python /fixture/check.py
docker compose -p minato-litellm-check logs --no-log-prefix proxy
docker compose -p minato-litellm-check down
```

| 用例 | 本地实测 |
| --- | --- |
| 原生 Responses | 到达 `/primary/v1/responses`，原样使用 `Model A`，返回 10 个 token |
| `429` 回退到 Chat | 用 `openai/chat_completions/` 模型前缀走 Chat，保留 JSON 格式和会话头，转换后客户端收到 12 个 token |
| 流式回退 | 备用 Chat 流转换为 `response.completed`，终态带 12 个 token |
| 普通上游 `400` | Proxy 默认回退会调用备用模型并返回成功。设置 `disable_fallbacks: true` 时，只有一次上游请求，返回原 `400`。受控情况下可显式发起第二次请求，客户端仍收到统一的 Responses 格式 |
| 动态添加与回滚基础 | Postgres 启用后，`/model/new` 和 `/config/update` 成功。在旧请求等待首选期间添加新版本，新请求用新备用，旧请求仍用旧备用。旧组随后也可直接调用 |
| 回调关联 | 使用检查脚本打印的 `trace` 查询 `FIXTURE_EVENT`，同一个 `litellm_call_id` 有首选失败和备用成功两条事件。首选没有上报 token，备用回调上报 12 |

Minato 首版使用 LiteLLM 执行协议转换与上游调用，由推理入口按指定错误类型选择下一候选。兼容性验证覆盖模拟协议和发布原语。真实上游、流式中断采集、审计持久化和 Minato 生效版本事务列入后续集成验收。
