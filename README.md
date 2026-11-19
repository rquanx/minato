# Minato

Minato 是基于 LiteLLM Proxy 的自托管 LLM 网关。业务按「项目 → 环境 → 功能点」接入，用固定别名发请求。管理员可以调整模型和回退策略，按功能点查看用量，并在开启调用审计后查看请求和响应、复制 Prompt、回放测试模型切换。

```text
业务应用 → Minato（LiteLLM Proxy）→ 首选模型来源
                                 └→ 备用模型来源
```

- [产品需求](docs/requirements.md)覆盖接入流程、首版范围和验收场景。
- [技术设计](docs/design.md)覆盖 API、模型目录、路由发布、用量、调用审计与回放。
- [详细设计](docs/implementation/index.md)定义接口契约、数据表、运行流程和首版验收用例。
- [MVP 实施计划](docs/roadmap.md)列出开发顺序、里程碑和第一批任务。
- [MVP Tickets](docs/tickets/README.md)列出各阶段可独立验收的开发任务。
- [自托管](docs/self-host.md)包含安装、接入和备份恢复方法。
- [上游兼容性](docs/provider-compatibility.md)记录实测协议和模型 ID 限制。

使用 Docker Compose 启动管理界面和推理入口。管理端默认通过 `http://localhost:8088` 访问。 [安装步骤](docs/self-host.md)
