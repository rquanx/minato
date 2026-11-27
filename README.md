# Minato

Minato is a self-hosted LLM gateway and control plane. Applications use stable model aliases scoped to a project, environment, and feature. Operators can change upstream models and fallback order in the console while applications keep using the same alias.

```text
Application → Minato → Go Runtime → Ordered upstream model candidates
                ↕
            PostgreSQL
```

## What Minato does

- **Route by feature.** Register a feature, specify its endpoint requirements, and configure an ordered model list. Environment defaults can fill open slots. Preview the resolved order, publish it, and roll back to a previous configuration. The runtime can try the next candidate after an eligible upstream failure.
- **Manage model sources and credentials.** Sync provider catalogs, add model IDs manually, override model capabilities, and verify models with test requests. Sources include CLIProxyAPI, OpenCode Go and Zen, OpenAI-compatible APIs, Anthropic, Gemini, and Vertex AI. Authentication options depend on the source and include API keys, imported credential files, and provider sign-in. [Provider compatibility](docs/provider-compatibility.md)
- **Track usage and investigate calls.** View token usage, estimated USD cost, errors, latency, and fallback trends by project or environment. Break usage down by feature, source, or model. Find calls by request ID or application correlation ID, or filter by model, status, and other request attributes.
- **Inspect and replay requests.** Enable content auditing per environment to retain encrypted request and response content. Inspect individual attempts, copy prompts, and replay a request against a route or a specific model.
- **Get notified when catalogs change.** Track model additions, removals, and source sync failures through in-app notifications or webhooks. Configure notification channels at the workspace, project, or environment level.

The default deployment includes Minato, a pinned Go Runtime for inference, and PostgreSQL. You can reuse an existing PostgreSQL instance. The Go Runtime handles OpenAI-compatible Responses, Chat Completions, and Embeddings, alongside Anthropic Messages and additional endpoints documented in the self-hosting guide. A separate Python LiteLLM compatibility deployment is available for integrations that require it. [Self-hosting guide](docs/self-host.md)

## Quick start

You need Bun, Git, and Docker Compose. Clone this repository, copy `.env.compose.example` to `.env`, and set the database password, administrator password, and service secrets. [Environment setup](docs/self-host.md#install)

```bash
bun tools/prepare-runtime.ts
docker compose up -d --build
curl -fsS http://localhost:8088/health/ready
```

Open the console at `http://localhost:8088`. Add a model source, create a project and environment, and issue an environment key. For this example, use the project slug `demo-app` and the environment slug `production`. Set `MINATO_ENVIRONMENT_KEY` in your shell and register a Responses feature.

```bash
curl -fsS -X PUT \
  http://localhost:8088/minato/v1/projects/demo-app/environments/production/features/classify \
  -H "Authorization: Bearer ${MINATO_ENVIRONMENT_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Classify text","requirements":{"endpoint":"responses"}}'
```

In **Projects → Feature routing**, select the feature, configure its model order, and publish the route. Once the route is serving, use the feature alias as the model in your client.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8088/v1",
  apiKey: process.env.MINATO_ENVIRONMENT_KEY,
});

const response = await client.responses.create({
  model: "demo-app.production.classify",
  input: "Classify this support ticket: I can't sign in.",
});

console.log(response.output_text);
```

## Release status

Minato is available as a self-hosted preview. CLIProxyAPI and OpenCode Go have been verified with live upstream requests. Claude, Gemini CLI, Antigravity, and Kimi Code subscription flows have passed simulated checks and are awaiting live-account validation. [Release and compatibility details](docs/provider-compatibility.md)

## Documentation

- [Installation, application setup, and recovery](docs/self-host.md)
- [Architecture and routing design](docs/design.md)
- [API and implementation details](docs/implementation/index.md)
- [Usage and query performance](docs/usage-performance.md)
- [LiteLLM migration strategy](docs/litellm-migration-strategy.md)
- [Product requirements](docs/requirements.md) and [roadmap](docs/roadmap.md)

## License

Minato is released under the [MIT License](LICENSE).
