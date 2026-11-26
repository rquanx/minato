import type { endpointPaths } from "./endpoints";

export const providerDefaultEndpoints = {
  openai: "chat-completions",
  cpa: "responses",
  "opencode-zen": "chat-completions",
  "opencode-go": "chat-completions",
  anthropic: "anthropic-messages",
  gemini: "chat-completions",
  vertex: "chat-completions",
  codex: "responses",
  claude: "anthropic-messages",
  "gemini-cli": "chat-completions",
  antigravity: "chat-completions",
  kimi: "chat-completions",
} as const satisfies Record<string, keyof typeof endpointPaths>;

export type ProviderKind = keyof typeof providerDefaultEndpoints;
export const googleSubscription = (kind: string) => kind === "gemini-cli" || kind === "antigravity";
export const browserSubscription = (kind: string) => kind === "claude" || googleSubscription(kind);
export const subscriptionRelay = (kind: string) => browserSubscription(kind) || kind === "kimi";
export const relativeProviderBase = (kind: string) => kind === "gemini" || kind === "vertex";
export const providerUrls: Partial<Record<ProviderKind, { directory: string; base: string }>> = {
  anthropic: { directory: "https://api.anthropic.com/v1/models", base: "https://api.anthropic.com/v1" },
  gemini: { directory: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    base: "https://generativelanguage.googleapis.com/v1beta/openai" },
  codex: { directory: "https://chatgpt.com/backend-api/codex/models?client_version=0.119.0",
    base: "https://chatgpt.com/backend-api/codex" },
  claude: { directory: "https://api.anthropic.com/v1/models", base: "https://api.anthropic.com/v1" },
  "gemini-cli": { directory: "", base: "https://cloudcode-pa.googleapis.com" },
  antigravity: { directory: "", base: "https://cloudcode-pa.googleapis.com" },
  kimi: { directory: "https://api.kimi.com/coding/v1/models", base: "https://api.kimi.com/coding/v1" },
};
