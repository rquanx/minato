# Self-host Minato

## Install

1. Copy `.env.compose.example` to `.env`. Set a PostgreSQL password and match it in the database URL. URL-encode reserved characters in the URL. Set a 12-character or longer administrator password, independent random secrets of at least 32 characters for the key pepper, audit encryption and callbacks, and a Runtime token.
2. Run `bun tools/prepare-runtime.ts` to fetch the pinned Go Runtime revision. Run `docker compose up -d --build`. Check `docker compose ps` and open `http://localhost:8088`. The migration container exits after applying pending migrations. The gateway returns ready at `/health/ready` once Minato, Runtime and Postgres are available.
3. Minato serves the console and APIs on the loopback listener. Postgres, Runtime and Minato's callback listener are reachable on the Compose network. For remote access, use a private connection or a TLS reverse proxy. Set `MINATO_PUBLIC_ORIGIN` to the exact public origin and use `MINATO_COOKIE_SECURE=true` with HTTPS.

To use the bundled Caddy reverse proxy, add `-f compose.yaml -f compose.caddy.yaml` to your Compose commands. Caddy takes over the loopback port and forwards requests to Minato.

## Use an existing PostgreSQL instance

Create a dedicated database and login role for Minato on the existing instance. The login needs permission to create and update tables in that database because the migration container runs before Minato starts. In `.env`, set `DATABASE_URL` to that database and use a hostname reachable from the Minato containers. On Docker Desktop, `host.docker.internal` reaches a PostgreSQL instance published on the host. For another Compose project on a shared Docker network, attach Minato and the migration service to that network and use the database service's network alias.

```bash
docker compose -f compose.yaml -f compose.external-db.yaml up -d --build
```

This configuration starts Minato and the Go Runtime and runs migrations against the configured database. The external database must be reachable before startup. Use the same Compose files for subsequent operations. For a deployment that already holds Minato data in its bundled database, back it up and restore it into the dedicated database before starting with the external configuration. Preserve the existing deployment secrets so issued keys and captured audit content remain usable.

## Go Runtime data plane

Minato sets the gateway's `LITELLM_GO_MANAGEMENT_API` and `LITELLM_GO_PROVIDER_APIS` to `false` and enables route publication with `LITELLM_GO_ROUTE_PUBLICATION_TOKEN`. The gateway applies complete route snapshots and performs inference and fallback. Set `MINATO_RUNTIME_PUBLISH_TOKEN` to use a separate credential for publication. Compose uses `MINATO_RUNTIME_TOKEN` for inference and as the default publication credential. Run `bun tools/prepare-runtime.ts` after changing Minato versions to update the pinned checkout. Set `MINATO_RUNTIME_BUILD_CONTEXT` to a checkout when developing the Runtime locally.

For multiple Runtime replicas, keep `MINATO_RUNTIME_BASE_URL` pointed at the inference load balancer and set `MINATO_RUNTIME_PUBLISH_URLS` to the comma-separated internal URLs of every replica. Route publication succeeds only after every listed replica accepts the snapshot.

## LiteLLM admin UI

With the Go Runtime, add the Dashboard listener once at deployment. Set a separate `LITELLM_UI_PASSWORD` and optionally `LITELLM_UI_USERNAME`, which defaults to `admin`. The Dashboard is served through Minato and the Runtime stays on the private network.

```bash
docker compose -f compose.yaml -f compose.dashboard.yaml up -d --build
```

In **LiteLLM Dashboard** in the Minato administrator console, turn on **Allow administrator access**, then select **Open Dashboard** and sign in with the LiteLLM credentials. Access starts off and the switch takes effect without restarting either service. Switching it off revokes access to the Dashboard and its APIs, including for already open tabs. Signing out of Minato also revokes that session's Dashboard access.

The default Dashboard origin is `http://localhost:18089`. For a remote deployment, set `MINATO_DASHBOARD_ORIGIN` to a separate public HTTPS origin and configure your reverse proxy to forward that origin to Minato port `4102`. Set `MINATO_PUBLIC_ORIGIN` to the console origin. If overriding `MINATO_DASHBOARD_PUBLIC_PORT` for loopback access, set the matching Dashboard origin. When combining Compose overrides, apply this file after `compose.caddy.yaml` so the Dashboard port mapping is retained.

### Python compatibility Dashboard

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

The Go Runtime data plane supports OpenAI-compatible Chat Completions, Responses, Completions, Embeddings, image generation and edits, speech synthesis, transcription, translation and moderations. It also supports Anthropic Messages at `/v1/messages`, reranking at `/v1/rerank` and OCR at `/v1/ocr`. Configure the model's endpoint in its directory metadata or override. Send the feature alias as the model. Anthropic clients may send the Minato environment key in `x-api-key`. Audio uploads and image edit files use multipart. The audit stores multipart field names and binary response metadata. Upload endpoint testing is available through the inference API. The Python compatibility data plane supports Responses, Chat Completions and Embeddings.

Add a source through Model sources. Set a credential reference such as `MINATO_UPSTREAM_EXAMPLE` in the deployment environment and restart the worker after adding or rotating that value. Set the directory URL and the inference API base for the provider. A source can supply individual model endpoint and capability overrides through `PUT /admin/v1/sources/{id}/models/{encoded-model-id}`. Search for the original model ID from the provider directory and preserve its casing.

Open a model in the source drawer to override its endpoint or verify availability. **Automatic** uses the model directory's endpoint when reported, then the source default. **Verify model** uses the source credential and records the outcome and time. Text models accept a custom test prompt and show a short response preview. The check uses upstream quota. Audio, image and OCR endpoints can be tested through the inference API with the required input.

Choose **Anthropic** for direct access to Claude with an Anthropic API key. Use `https://api.anthropic.com/v1/models` as the directory and `https://api.anthropic.com/v1` as the inference base. Native Messages routes use the Go Runtime. Use **OpenAI compatible** for providers that expose the required OpenAI-compatible directory and inference endpoints. Models exposed by CPA can share a single CPA source in Minato.

Choose **Google Gemini** for direct Google AI Studio access through its OpenAI-compatible API. The source form fills the Google directory and inference URLs automatically. Use a Google AI Studio API key with this source.

Choose the authentication method when creating a source, or open **Credentials** on an existing source. The **Authentication files** page lists managed credentials and their sources. It also lets administrators replace or remove a credential, review the listed models, and enable or disable its source. API key files accept an `apiKey` or `api_key` field and can be downloaded by an administrator. Minato encrypts imported credentials in PostgreSQL and uses them for directory sync, model verification and route publication. Keep `MINATO_CREDENTIAL_SECRET` with deployment backups if set. Minato uses `MINATO_AUDIT_SECRET` as the default encryption key.

### Provider sign-in and credential files

- **Codex** supports browser sign-in, device codes, and Codex CLI or CPA Codex JSON files containing access and refresh tokens. Browser sign-in returns to `http://localhost:1455/auth/callback`. Add `-f compose.oauth-loopback.yaml` to a local Compose deployment to receive this callback when port 1455 is available on the machine running the browser. If the browser cannot reach the callback, copy the full address from its address bar and paste it into **Callback URL** in the open authorization form. The device-code option works without a local listener. Codex inference uses the Go Runtime. On a custom deployment, set `MINATO_PROVIDER_RELAY_BASE_URL` to the Minato URL reachable from the Runtime. Compose sets this internal URL.
- **Google Vertex AI** accepts a Google Cloud service account file. Set the inference base to the project's OpenAI-compatible Vertex endpoint, such as `https://aiplatform.googleapis.com/v1/projects/PROJECT/locations/global/endpoints/openapi`. Add the model ID manually and use it as the test model during import. The default directory setting for Vertex is off.
- **Claude** is the subscription source. Set `MINATO_OAUTH_CLAUDE_CLIENT_ID` to an OAuth client authorized for the requested Claude scopes. Minato uses the Claude callback at `http://localhost:54545/callback` and serves Anthropic Messages.
- **Gemini CLI** and **Antigravity** each use their own Google OAuth client. Set `MINATO_OAUTH_GEMINI_CLI_CLIENT_ID`, `MINATO_OAUTH_GEMINI_CLI_CLIENT_SECRET`, `MINATO_OAUTH_ANTIGRAVITY_CLIENT_ID`, and `MINATO_OAUTH_ANTIGRAVITY_CLIENT_SECRET` for the providers you use. Register or enable their local callbacks at `http://localhost:8085/oauth2callback` and `http://localhost:51121/oauth-callback`, respectively. Minato discovers the Code Assist project after sign-in. For an account that needs an explicit project, set `MINATO_GOOGLE_PROJECT_<SOURCE_SLUG>` with the slug uppercased and hyphens replaced by underscores. Add the upstream model IDs manually and select Chat Completions or Responses when registering a feature.
- **Kimi Code** uses device-code login. Open the verification page, enter the displayed code, and leave Minato open until it confirms authorization. Minato retains the device identity for refresh and Chat Completions.
- **OpenAI-compatible OAuth** uses the upstream's registered OAuth client and requires a Bearer token accepted by that upstream's model APIs. For a source named `my-provider`, set `MINATO_OAUTH_MY_PROVIDER_AUTHORIZATION_URL`, `MINATO_OAUTH_MY_PROVIDER_TOKEN_URL`, `MINATO_OAUTH_MY_PROVIDER_CLIENT_ID`, and any required `MINATO_OAUTH_MY_PROVIDER_CLIENT_SECRET` and `MINATO_OAUTH_MY_PROVIDER_SCOPE`. Register `<console-origin>/oauth/provider/callback` with the provider and open the console at that origin. The public console origin uses HTTPS, with HTTP available for local loopback. The source's **Sign in with OAuth** button starts authorization.

Minato renews access tokens before they expire and republishes approved routes when the token changes. The source shows its expiry and prompts for reauthorization when the provider rejects refresh. OAuth tokens and service-account private keys stay in encrypted storage.

Claude, Gemini CLI, Antigravity, and Kimi Code accept compatible provider authentication files and use the Go Runtime and Minato provider relay. The browser authorization forms also accept a pasted callback URL. The local Compose callback override publishes their loopback ports.

An imported credential or completed sign-in creates a subscription account. To share it, open **Credentials** on another model source and choose **Link account**. Shared sources must use the same provider and permitted API origins. Reauthorizing or replacing the credential from its original source updates the linked sources. Unlinking a source leaves the account in **Authentication files**. Once the account has no linked sources, it can be removed there.

Minato validates an imported key against the model directory or a specified test model before saving it. Use a model ID when the directory is public or disabled. Active routes keep their current credential until a new route version is published. To remove an imported key, configure an environment key on Minato and the Runtime or explicitly disable the source. Superseded credentials become eligible for cleanup after 24 hours once no current, pending or legacy fixed route needs them.

If the provider lacks a usable directory, turn off **Synchronize model directory** in source settings and use **Add model** in the source drawer. Add the exact model ID and, when needed, select its endpoint. Directory refreshes preserve manually added models. **Diagnostics** shows the latest sync result, its failure reason when available and the active feature routes using the source.

To import CPA authentication files from Minato, configure the CPA management origin and management key separately from the inference key. For a source named `local-cpa`, set `MINATO_CPA_MANAGEMENT_URL_LOCAL_CPA` and `MINATO_CPA_MANAGEMENT_KEY_LOCAL_CPA` on the Minato service. The **Authentication files** section shows file status and accepts individual CPA JSON credential files up to 256 KiB. Minato forwards each file to CPA and queues a directory refresh after import. CPA stores and uses the credentials.

Optional pricing fields can be set in the same model override. Use `inputPricePerMillion`, `outputPricePerMillion`, `cachedInputPricePerMillion` and `priceCurrency`. The usage page estimates USD cost from input and output prices when both values are configured. It groups daily estimates by the UTC date of the call and shows how many attempts contributed to each estimate.

Create a project and environment in Projects, then issue an environment key. Register a feature without including any upstream credentials.

```bash
curl -fsS -X PUT http://localhost:8088/minato/v1/projects/demo-app/environments/production/features/classify \
  -H "Authorization: Bearer ${MINATO_ENVIRONMENT_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Classify text","requirements":{"endpoint":"responses"}}'
```

Select the registered feature and configure an ordered model list. Preview the first three eligible candidates before publishing. The preview also lists incompatible models and candidates beyond the attempt limit. Query the same feature URL with GET to check its status. Use the returned alias in OpenAI SDK calls.

To automatically publish newly registered features, enable automatic publication under **Projects → Default models**. With an empty model list, Minato starts with the feature's registered model if eligible, then fills the route from the environment pool. An ordered list set by an administrator takes precedence. For embedding fallbacks, set matching `embeddingSpace` and `embeddingDimensions` in the feature requirements and model capability overrides. Keep those values tied to the persisted vector index.

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

## Find calls and inspect usage

The inference response includes `X-Request-Id`. To associate calls with an application job, order, or trace, send `X-Minato-Correlation-Id` with up to 128 letters, digits, dots, underscores, colons, slashes, or hyphens. Search for either identifier in Calls. Model and source filters match any attempt in the call. Use the time window and status filters to narrow incident searches.

Usage shows call-level success, fallback and end-to-end latency. Token and cost metrics sum model attempts. A request with retries can appear in more than one source or model group. New attempts store the USD price configuration when recorded. Legacy attempts without a snapshot use the current configured prices. Unfiltered environment and project reports use hourly summaries when the selected hours are ready. Percentiles from the hourly data use 50 ms buckets. Filtered and grouped reports read call details.

Test and Replay start a fresh upstream session and display model attempts with status, latency and reported usage. Replays use the provided request body and selected route or model.

## Model change notifications

The Notifications page lists confirmed additions, removals, restorations and changes to model metadata, plus source synchronization failures and recoveries. The initial successful directory fetch establishes the baseline. Events for sources with active or approved routes include the affected project and environment. Sources without such routes use the global channels.

In-app activity is enabled globally by default. Project channels inherit the global channels, and environment channels inherit the project channels. Each scope can set its own list, including an empty list to mute it.

Add an HTTPS destination under **Notifications → Webhooks**, then select it in the channel settings for the scope that should receive model changes. Dashboard-managed URLs are encrypted with `MINATO_AUDIT_SECRET` and must resolve to a public IPv4 address. Deployment variables such as `MINATO_NOTIFY_WEBHOOK_OPERATIONS` also register destinations.

Use **Send test** to send one synthetic event and see the response status. The test works before subscribing a scope and uses the same event shape with an extra `test: true` field. Minato posts one JSON event per subscribed channel with an event ID and an `Idempotency-Key` header. Catalog event delivery is retried up to five total attempts.

## Upgrade and recover

The default Compose stack keeps completed production audit events in a persistent SQLite journal before writing them to PostgreSQL. PostgreSQL receives each call, its attempts, usage and encrypted content in one transaction. Minato replays pending entries after a restart. Keep the `auditjournal` volume when updating or moving the service. For a non-Compose install, set `MINATO_AUDIT_JOURNAL` to a writable path on persistent storage. Check `journalPending` and `lost` under `/health/ready` when diagnosing audit delivery.

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
