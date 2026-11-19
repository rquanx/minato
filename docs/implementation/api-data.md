# 接口、权限与数据

## 路径与身份

管理 API 位于 `/admin/v1`，项目成员使用同源管理会话。应用注册位于 `/minato/v1`，推理使用 `/v1`。业务始终使用同一把环境 Key 调用注册和推理。Minato 保存随机 Key 的公开标识和服务端 HMAC 校验值，使用恒定时间比较。明文只在签发时返回，轮换通过先签发新 Key、验证接入、再撤销旧 Key 完成。撤销后的新请求立即失效，已鉴权的在途请求按原期限完成。

首版管理端用部署时初始化的管理员账号和服务端会话。项目管理员分配已有用户的项目权限。会话通过同源 `HttpOnly` Cookie 传递，写操作校验 Origin 和 CSRF token。平台和来源凭证通过部署 Secret 或加密凭证记录引用，管理 API 写入后只返回变更状态与凭证引用。

项目、环境和功能点 slug 使用 1–48 位小写字母、数字和连字符，首尾为字母或数字。内部关系使用 UUID，业务别名由三个 slug 以 `.` 连接。建立环境后 slug 固定，显示名称可修改。归档保留标识和历史归因，拒绝新请求。来源和模型由平台管理员维护，项目可引用授权的来源。已开启的权限只在所属项目和环境内生效。

| 权限 | 操作 |
| --- | --- |
| 平台管理员 | 创建项目、管理来源和凭证、分配项目管理员 |
| 项目管理员 | 管理本项目环境和 Key、配置与发布路由、开启审计、设置保留期及授予内容和测试权限 |
| 用量查看 | 查看授权环境的请求元数据、上游尝试、用量与配置变更历史 |
| 内容查看 | 读取或复制授权环境的请求和响应正文，另外需要可查看该调用记录 |
| 测试执行 | 为授权环境运行测试，历史回放还要求有权查看原调用正文 |
| 环境 Key | 登记本环境的功能点、调用本环境已启用的别名 |

## API 清单

| 方法和路径 | 主要输入及结果 |
| --- | --- |
| `POST /admin/v1/projects` | `slug`、`displayName`。返回 `201` 和项目 ID |
| `GET /admin/v1/projects`、`GET /admin/v1/projects/{project}/environments` | 列出当前用户有权查看的项目和环境 |
| `POST /admin/v1/projects/{project}/environments` | `slug`、`displayName`。返回 `201` 和环境 ID |
| `PUT /admin/v1/projects/{project}/members/{user}` | 设置项目角色和环境权限 |
| `POST /admin/v1/projects/{project}/environments/{env}/keys` | `label`、可选 `expiresAt`。返回 `201`、明文 Key 和 ID |
| `GET /admin/v1/projects/{project}/environments/{env}/keys` | 返回 ID、名称、状态及有效期 |
| `DELETE /admin/v1/projects/{project}/environments/{env}/keys/{id}` | 撤销 Key，重复提交返回 `204` |
| `PUT /minato/v1/projects/{project}/environments/{env}/features/{feature}` | 登记或更新功能声明。返回固定别名、声明版本和发布状态 |
| `GET /minato/v1/projects/{project}/environments/{env}/features/{feature}` | 返回功能点状态、允许调用的 API 和当前版本 |
| `POST /v1/chat/completions`、`POST /v1/responses` | OpenAI 兼容请求，`model` 为功能点别名，响应头包含 `X-Request-Id` |
| `GET /v1/models` | 列出当前环境可用的功能点别名 |
| `POST /admin/v1/sources`、`PATCH /admin/v1/sources/{id}` | 来源类型、API Base、凭证引用、访问范围和目录配置 |
| `POST /admin/v1/sources/{id}/sync`、`GET /admin/v1/sources/{id}/models` | 触发同步返回任务 ID，或读取快照和目录状态 |
| `PUT /admin/v1/environments/{id}/audit-policy` | 内容开关、保留期、正文上限和脱敏配置，提交时携带配置版本 |
| `PUT /admin/v1/environments/{id}/defaults` | 更新环境默认池，按列表顺序匹配候选 |
| `PUT /admin/v1/features/{id}/routing` | 更新草稿，提交 `expectedRevision` 防止覆盖并行编辑 |
| `POST /admin/v1/features/{id}/routing/preview` | 返回符合条件的候选、排除原因、快照和草稿版本 |
| `POST /admin/v1/features/{id}/routing/publish` | 提交草稿版本，返回 `202` 和发布任务 ID |
| `POST /admin/v1/features/{id}/routing/rollback` | 提交历史版本和预期当前版本，按相同准备流程发布 |
| `GET /admin/v1/jobs/{id}` | 查询同步、发布或测试任务状态 |
| `GET /admin/v1/environments/{id}/calls` | 按时间、功能点、状态、来源、模型或调用类型筛选，稳定游标翻页 |
| `GET /admin/v1/calls/{id}`、`GET /admin/v1/calls/{id}/content` | 分别读取元数据与正文，在服务端校验环境权限 |
| `DELETE /admin/v1/calls/{id}/content` | 项目管理员删除可保留的正文并记录操作，调用元数据继续保留 |
| `GET /admin/v1/environments/{id}/usage` | 返回按日期、功能点或模型聚合的用量、未知计数和时段 |
| `POST /admin/v1/environments/{id}/tests` | 新建测试或回放。提交 `Idempotency-Key`，返回 `202` 和测试 ID |
| `GET /admin/v1/tests/{id}` | 读取测试状态、结果、原请求关联和用量 |

带时间筛选的管理端列表使用 UTC `from`（含）和 `to`（不含）。分页 `limit` 默认 50、最多 200，游标编码筛选条件和最后一条排序位置。一般清单按 `(createdAt, id)` 降序，调用记录按 `(startedAt, requestId)` 降序。POST 创建和异步触发操作接受 `Idempotency-Key`。同一身份、接口和 Key 重复提交相同请求摘要时返回原资源或任务，摘要不同返回 `409`。环境 Key 的创建结果仅在首次响应提供明文，重试返回 Key ID 和状态。

## 注册契约

```http
PUT /minato/v1/projects/demo-app/environments/production/features/text-classification
Authorization: Bearer <environment-key>
Content-Type: application/json

{
  "displayName": "文本分类",
  "preferredModel": { "sourceId": "demo-provider", "modelId": "example-model" },
  "requirements": {
    "endpoint": "responses",
    "minContextTokens": 32000,
    "structuredOutput": "json_schema",
    "streaming": false
  }
}
```

```json
{
  "alias": "demo-app.production.text-classification",
  "registrationRevision": 1,
  "routingStatus": "pending",
  "activeRouteVersion": null
}
```

初次注册返回 `201`，后续 `PUT` 返回 `200`。同一声明重复提交保留版本，变更声明会更新该项目提交的预设并触发重算。管理员覆盖独立保存。声明与当前生效候选冲突时标为待发布，当前请求按已发布合同校验。应用用 `GET` 查询新合同是否已生效。身份错误 `401`，权限错误 `403`，跨项目资源详情返回 `404`，语法错误 `400`，字段语义错误 `422`，版本冲突 `409`，未生效的别名 `503`。管理错误包含 `code`、`message`、`requestId` 和可选 `details`。推理错误使用 OpenAI `error` 结构并保留请求 ID。

## 数据表与约束

| 表 | 主键或唯一键 | 核心字段 |
| --- | --- | --- |
| `projects` | `id`、`slug` 唯一 | `display_name`、`archived_at` |
| `environments` | `id`、`(project_id, slug)` 唯一 | `default_pool`、`settings_revision`、审计策略 |
| `environment_keys` | `id`、`public_key_id` 唯一 | `environment_id`、校验值、过期与撤销时间 |
| `memberships` | `(user_id, project_id)` | 项目角色与环境授权集合 |
| `features` | `id`、`(environment_id, slug)` 和 `alias` 唯一 | 声明、覆盖、草稿版本、期望版本、生效版本 |
| `sources` | `id`、`slug` 唯一 | 来源类型、目录地址、凭证引用、配置版本、禁用状态 |
| `source_models` | `(source_id, raw_model_id)` | 能力字段、目录状态、成功缺失次数、最近出现时间、能力覆盖 |
| `catalog_syncs` | `id` | 来源、配置版本、开始和结束时间、快照摘要、结果与差异 |
| `route_versions` | `(feature_id, version)` | 草稿及目录版本、候选快照、运行时引用、发布状态、创建人 |
| `jobs` | `id` | 类型、提交摘要、租约、尝试次数、执行状态与错误摘要 |
| `calls` | `request_id` | 环境、功能点、路由版本、类型、终态、实际模型、延迟 |
| `call_attempts` | `(request_id, attempt_id)` | 开始和结束、来源、模型、回退原因、usage、去重来源 |
| `call_content` | `(request_id, kind)` | 加密内容、采集状态、摘要、截断标记和 `expires_at` |
| `tests` | `id`、`request_id` 唯一 | 环境、发起人、原请求、目标、执行状态、输入保留期限 |
| `admin_events` | `id` | 执行人、资源、操作、范围、时间和配置版本 |

默认值和声明用 JSONB 保存，版本和关键关系用显式列及外键约束。`calls` 建立 `(environment_id, started_at DESC, request_id DESC)` 索引和按功能点的时间索引。`call_content.expires_at`、`jobs(status, available_at)` 建索引。新增声明、创建发布任务和更新期望版本使用同一事务。异步任务按资源串行领取，租约过期由后台进程恢复。控制变更和正文读取使用 `admin_events` 留痕，事件正文仅保存资源标识、时间和动作。
