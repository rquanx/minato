# Provider compatibility

The adapter checks in the table used official LiteLLM `v1.85.0` and synthetic prompt text. Configure the directory URL, inference base URL and credentials for the deployment. Provider model availability is account-specific and changes over time.

| Provider | Verified behavior | Model selection |
| --- | --- | --- |
| CLIProxyAPI | Authenticated model directory and native Responses. One advertised canonical model returned a successful Responses object with token usage. | A model absent from the directory returned an error. A display-style ID also failed even though it appeared in the list. Preserve the exact advertised identifier and verify it through a test call before publication. |
| OpenCode Go | Authenticated directory, Responses-to-Chat conversion, completion and streaming usage using the configured endpoint. | Select a Chat model from the Go directory and set its API base according to the provider's published endpoint for that model. |
| OpenCode Zen | Configurable independent directory, base URL and credential, using the OpenAI-compatible adapter. | Per-model inference and context capabilities depend on the configured account. |

The simulated fallback suite also verified JSON object conversion and session header forwarding. It exercises provider failure, version changes and failed-attempt usage separately from the live provider checks. [Reproduction commands](../tools/litellm-compat/README.md)

## Default Go runtime acceptance

On 2026-11-25, an isolated Minato and Go Runtime deployment synchronized an authenticated CLIProxyAPI model directory, registered a feature, published its route, and streamed a synthetic request through `/v1/responses`. The terminal event reported 18 tokens. PostgreSQL recorded an HTTP 200 attempt with the same token count and one audit record each for the request and response.

On 2026-11-25, the same deployment setup synchronized 37 models from the authenticated OpenCode Go directory at `https://opencode.ai/zen/go/v1/models`. The directory sync recognized advertised Responses, Chat Completions, Anthropic Messages and Embeddings endpoints. A synthetic streaming request to `gpt-5.6-luna` via Minato `/v1/responses` completed successfully. PostgreSQL recorded the request and response audit bodies and the same usage reported in the terminal event (11 input tokens and 5 output tokens).

OpenCode Go inference required an `x-opencode-session` header, which Minato and the Go runtime forwarded from the request. Directory listing and inference eligibility are separate. The directory included `deepseek-v4.1-flash`, but the upstream rejected the test request under the account's data region policy. Go runtime fallback is covered by the separate simulated upstream tests.

On 2026-11-26, an isolated deployment without CPA imported an OpenCode Go API key, authenticated and synchronized 37 models, published a route, and streamed a synthetic Responses request to `gpt-5.6-luna`. The terminal event and PostgreSQL both recorded 15 tokens. PostgreSQL also recorded the request and response audit bodies.

## Subscription provider compatibility

CLIProxyAPI revision `2c626efc` was used as the protocol reference for Claude, Gemini CLI, Antigravity and Kimi Code. The OAuth, token refresh and inference flows were exercised against simulated vendor endpoints. `bun test tools/subscription-compat.test.ts` covers additional CPA-compatible request and response cases. Live sign-in and inference for these four subscription providers still require verification with authorized accounts.
