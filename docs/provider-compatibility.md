# Provider compatibility

Validation used official LiteLLM `v1.85.0` and synthetic prompt text through the Minato provider adapter. Configure the directory URL, inference base URL and credentials for the deployment. Provider model availability is account-specific and changes over time.

| Provider | Verified behavior | Model selection |
| --- | --- | --- |
| CLIProxyAPI | Authenticated model directory and native Responses. One advertised canonical model returned a successful Responses object with token usage. | A model absent from the directory returned an error. A display-style ID also failed even though it appeared in the list. Preserve the exact advertised identifier and verify it through a test call before publication. |
| OpenCode Go | Authenticated directory, Responses-to-Chat conversion, completion and streaming usage using the configured endpoint. | Select a Chat model from the Go directory and set its API base according to the provider's published endpoint for that model. |
| OpenCode Zen | Configurable independent directory, base URL and credential, using the OpenAI-compatible adapter. | Per-model inference and context capabilities depend on the configured account. |

The simulated fallback suite also verified JSON object conversion and session header forwarding. It exercises provider failure, version changes and failed-attempt usage separately from the live provider checks. [Reproduction commands](../tools/litellm-compat/README.md)

## Default Go runtime acceptance

On 2026-11-25, an isolated Minato and Go Runtime deployment synchronized an authenticated CLIProxyAPI model directory, registered a feature, published its route, and streamed a synthetic request through `/v1/responses`. The terminal event reported 18 tokens. PostgreSQL recorded an HTTP 200 attempt with the same token count and one audit record each for the request and response.

OpenCode Go returned HTTP 401 on the authenticated model directory request with the available credential. The live OpenCode Go streaming and usage checks require a working credential. The Go runtime's fallback behavior is covered by the separate simulated upstream tests.
