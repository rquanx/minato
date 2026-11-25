# Self-host Minato

## Install

1. Copy `.env.compose.example` to `.env`. Set a PostgreSQL password and match it in the database URL. URL-encode reserved characters in the URL. Set a 12-character or longer administrator password, independent random secrets of at least 32 characters for the key pepper, audit encryption and callbacks, and a Runtime token.
2. Run `docker compose up -d --build`. Check `docker compose ps` and open `http://localhost:8088`. The migration container exits after applying pending migrations. The gateway returns ready at `/health/ready` once Minato, Runtime and Postgres are available.
3. Minato serves the console and APIs on the loopback listener. Postgres, Runtime and Minato's callback listener are reachable on the Compose network. For remote access, use a private connection or a TLS reverse proxy. Set `MINATO_PUBLIC_ORIGIN` to the exact public origin and use `MINATO_COOKIE_SECURE=true` with HTTPS.

To use the bundled Caddy reverse proxy, add `-f compose.yaml -f compose.caddy.yaml` to your Compose commands. Caddy takes over the loopback port and forwards requests to Minato.

## Go Runtime data plane

Minato sets the gateway's `LITELLM_GO_MANAGEMENT_API` and `LITELLM_GO_PROVIDER_APIS` to `false` and enables route publication with `LITELLM_GO_ROUTE_PUBLICATION_TOKEN`. The gateway applies complete route snapshots and performs inference and fallback. Set `MINATO_RUNTIME_PUBLISH_TOKEN` to use a separate credential for publication. Compose uses `MINATO_RUNTIME_TOKEN` for inference and as the default publication credential. From the Minato repository root, clone the Runtime into the directory Compose expects.

```bash
git clone https://github.com/rquanx/litellm-go.git ../minato-runtime
```

If the Runtime is already checked out in another directory, set `MINATO_RUNTIME_BUILD_CONTEXT` to that directory in the Compose environment.

For multiple Runtime replicas, keep `MINATO_RUNTIME_BASE_URL` pointed at the inference load balancer and set `MINATO_RUNTIME_PUBLISH_URLS` to the comma-separated internal URLs of every replica. Route publication succeeds only after every listed replica accepts the snapshot.

## LiteLLM admin UI

LiteLLM remains available as a migration compatibility data plane. Set `LITELLM_MASTER_KEY` and `LITELLM_UI_PASSWORD` in your Compose environment. `LITELLM_UI_USERNAME` defaults to `admin` and `LITELLM_UI_PORT` defaults to `18089`. Enable the compatibility stack and loopback listener by applying both overrides to the same Compose project.

```bash
docker compose -f compose.yaml -f compose.litellm.yaml -f compose.litellm-admin.yaml up -d --build
```

Open `http://127.0.0.1:18089/ui/` and sign in with those credentials. The loopback listener serves the LiteLLM Proxy, including the UI and the API routes the UI uses. Set `MINATO_DATA_PLANE=litellm` through the compatibility override when Minato should use it for inference.

## Hybrid data plane

The hybrid profile adds a private LiteLLM service alongside Minato's Go Runtime. Configure `LITELLM_DATABASE_URL` with a separate PostgreSQL schema and set `LITELLM_MASTER_KEY`. Configure the compatibility model aliases in LiteLLM. For a custom YAML configuration, set `LITELLM_CONFIG_DIR` to a directory containing `litellm.yaml` and any modules it imports.

```bash
docker compose -f compose.yaml -f compose.hybrid.yaml --profile hybrid up -d --build
```

Register an OpenAI-compatible source with directory URL `http://litellm:4000/v1/models` and inference API base `http://litellm:4000/v1`. Set `MINATO_UPSTREAM_LITELLM` in the Minato and Runtime environment to a LiteLLM virtual key scoped to the compatibility aliases, then select that credential reference for the source. After catalog sync, add a listed alias to a feature's fallbacks or the environment's default pool and publish the route. Go retries eligible failures on the published candidates, and Minato republishes approved policies when source availability changes. Calls retain the business alias and Minato records both attempts and the returned usage. This path supports the inference endpoints exposed by Minato.

To open the upstream dashboard alongside Minato, set `LITELLM_UI_PASSWORD` and layer the static frontend override onto the hybrid configuration.

```bash
docker compose -f compose.yaml -f compose.hybrid.yaml -f compose.hybrid-ui.yaml --profile hybrid up -d --build
```

Open `http://127.0.0.1:18089/ui/`, or use the port set in `LITELLM_UI_PORT`. Caddy serves the pinned Dashboard export and forwards its login and administration API calls to the private LiteLLM service. The Minato console manages Minato projects, feature policies and call audits. The LiteLLM Dashboard manages the compatibility service and its own records.

## Connect an application

Add a source through Model sources. Set a credential reference such as `MINATO_UPSTREAM_EXAMPLE` in the deployment environment and restart the worker after adding or rotating that value. Set the directory URL and the inference API base for the provider. A source can supply individual model endpoint and capability overrides through `PUT /admin/v1/sources/{id}/models/{encoded-model-id}`. Search for the original model ID from the provider directory and preserve its casing.

Optional pricing fields can be set in the same model override. Use `inputPricePerMillion`, `outputPricePerMillion`, `cachedInputPricePerMillion` and `priceCurrency`. The usage page estimates USD cost from input and output prices when both values are configured. It groups daily estimates by the UTC date of the call and shows how many attempts contributed to each estimate.

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

Keep a copy of the deployment configuration and secret values. The key pepper is required to validate previously issued keys. The audit secret is required to decrypt saved content. The Runtime token and upstream credential references are required to restore the data plane. Store those secrets separately from database archives.

Create a database archive before updating the image or schema. The PostgreSQL database stores Minato control, audit and usage data.

```bash
docker compose exec -T postgres pg_dump -U minato -Fc minato > minato.dump
docker compose up -d --build --remove-orphans
```

The first command uses byte-preserving redirection in Bash. On other shells, write the archive inside the container with `pg_dump -f /tmp/minato.dump` and use `docker compose cp`.

When upgrading from separate Minato control, ingress and worker containers, run the upgrade under the existing Compose project. `--remove-orphans` removes the old Minato containers and releases the old gateway port. Minato serves the console and inference from one process after the upgrade, so restarting it briefly interrupts both. LiteLLM schema data remains in Postgres when the compatibility stack is enabled.

To rehearse recovery, use a separate Compose project and an unused gateway port. Restore the archive into an empty database before starting either migration process, then set both database URLs to the restored database and preserve the schema query parameter for LiteLLM. Validate that the environment key still authenticates, active routing can be read and the audit policy matches the original deployment. Restore migrations and application versions together if an upgrade requires rolling back an incompatible schema.

Preflight tests use the isolated [LiteLLM fixture](../tools/litellm-compat/README.md). For Minato development, start `compose.dev.yaml` and the LiteLLM fixture with `tools/litellm-compat/host.yaml`, set the database URL from `.env.example`, then run `bun run db:migrate`, `bun run smoke` and `bun tools/catalog-smoke.ts`.
