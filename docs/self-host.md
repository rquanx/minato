# Self-host Minato

## Install

1. Copy `.env.compose.example` to `.env`. Set a PostgreSQL password and match it in both database URLs. URL-encode reserved characters in the URLs. Set a 12-character or longer administrator password, plus independent random secrets of at least 32 characters for the key pepper, audit encryption and callbacks. Choose a stable LiteLLM master key starting with `sk-`.
2. Run `docker compose up -d --build`. Check `docker compose ps` and open `http://localhost:8088`. The migration container exits after applying pending migrations. The LiteLLM container runs its schema migration on startup. The gateway returns ready at `/health/ready` once Minato and LiteLLM are available.
3. Keep PostgreSQL and LiteLLM on the Compose network. The gateway binds to loopback. For remote access, use a private connection or a TLS reverse proxy. Set `MINATO_PUBLIC_ORIGIN` to the exact public origin and use `MINATO_COOKIE_SECURE=true` with HTTPS.

## Connect an application

Add a source through Model sources. Set a credential reference such as `MINATO_UPSTREAM_EXAMPLE` in the deployment environment and restart the worker after adding or rotating that value. Set the directory URL and the inference API base for the provider. A source can supply individual model endpoint and capability overrides through `PUT /admin/v1/sources/{id}/models/{encoded-model-id}`. Search for the original model ID from the provider directory and preserve its casing.

Create a project and environment in Projects, then issue an environment key. Register a feature without including any upstream credentials.

```bash
curl -fsS -X PUT http://localhost:8088/minato/v1/projects/demo-app/environments/production/features/classify \
  -H "Authorization: Bearer ${MINATO_ENVIRONMENT_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Classify text","requirements":{"endpoint":"responses"}}'
```

Select the registered feature and configure a primary candidate and optional backups. Save the draft, then publish it. Query the same feature URL with GET to check its status. Use the returned alias in OpenAI SDK calls.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8088/v1",
  apiKey: process.env.MINATO_ENVIRONMENT_KEY,
});
const response = await client.responses.create({
  model: "demo-app.production.classify",
  input: "Classify this example: the demo app won't launch.",
});
console.log(response.output_text);
```

## Upgrade and recover

Keep a copy of the deployment configuration and secret values. The key pepper is required to validate previously issued keys. The audit secret is required to decrypt saved content. The LiteLLM master key is required to read previously staged model definitions. Store those secrets separately from database archives.

Create a database archive before updating the image or schema. The single PostgreSQL database includes both the Minato and LiteLLM schemas in the default Compose deployment.

```bash
docker compose exec -T postgres pg_dump -U minato -Fc minato > minato.dump
docker compose up -d --build
```

The first command uses byte-preserving redirection in Bash. On other shells, write the archive inside the container with `pg_dump -f /tmp/minato.dump` and use `docker compose cp`.

To rehearse recovery, use a separate Compose project and an unused gateway port. Restore the archive into an empty database before starting either migration process, then set both database URLs to the restored database and preserve the schema query parameter for LiteLLM. Validate that the environment key still authenticates, active routing can be read and the audit policy matches the original deployment. Restore migrations and application versions together if an upgrade requires rolling back an incompatible schema.

Preflight tests use the isolated [LiteLLM fixture](../tools/litellm-compat/README.md). For Minato development, start `compose.dev.yaml` and the LiteLLM fixture with `tools/litellm-compat/host.yaml`, set the database URL from `.env.example`, then run `bun run db:migrate`, `bun run smoke` and `bun tools/catalog-smoke.ts`.
