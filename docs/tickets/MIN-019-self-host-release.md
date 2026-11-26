# MIN-019 自托管安装与发布验收

里程碑为 M5 自托管发布。 [Ticket 索引](README.md)

直接依赖 [MIN-017](MIN-017-replay-console.md)、[MIN-018](MIN-018-provider-acceptance.md)。 [相关设计](../implementation/delivery.md)

## 交付范围

- 提供 Compose 安装、持久化配置、升级、备份恢复和业务接入文档。使用公开示例完成发布验收。

## 验收条件

- [x] 干净环境可安装并完成示例接入。恢复演练可还原环境凭证、已发布路由及保留策略。
- [x] 记录经验证的 LiteLLM 镜像、上游协议和已知限制。

## 预览版复验

2026-11-27 在独立 Compose 项目中从空 PostgreSQL 数据库启动默认 Go Runtime 部署，应用迁移 001–024。使用模拟上游完成管理员登录、环境密钥签发、功能注册、路由发布、OpenAI SDK 推理、按关联 ID 查询调用、读取请求和响应审计、Token 用量核对、回放期间发布另一版本，以及保留业务别名的切换和回滚。验收由 `bun tools/deployment-smoke.ts` 执行。

复验时使用独立的 Compose 项目和新的数据库。按[自托管文档](../self-host.md)准备环境文件，将 `MINATO_PUBLIC_PORT` 和 `MINATO_PUBLIC_ORIGIN` 设为可用的本地端口和对应地址，并在环境文件里加入 `MINATO_UPSTREAM_RELEASE_FIXTURE=fixture-key`。

```bash
bun install --frozen-lockfile
bun tools/prepare-runtime.ts
export MINATO_ENV_FILE=.env.release-check
docker compose --env-file "$MINATO_ENV_FILE" -p minato-release-check up -d --build
docker run --rm -d --name minato-release-check-fixture --network minato-release-check_default \
  --network-alias fixture --mount "type=bind,source=$PWD/tools/litellm-compat/mock_upstreams.py,target=/fixture.py,readonly" \
  python:3.12-alpine python /fixture.py --host 0.0.0.0
```

将 `MINATO_SMOKE_PASSWORD` 设为该环境的管理员密码，将 `MINATO_SMOKE_ORIGIN` 设为对应的本地地址，再执行以下命令。

```bash
MINATO_SMOKE_FIXTURE=http://fixture:18765 bun tools/deployment-smoke.ts
docker stop minato-release-check-fixture
docker compose --env-file "$MINATO_ENV_FILE" -p minato-release-check down --volumes
```

