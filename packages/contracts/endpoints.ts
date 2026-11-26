export const endpointPaths = {
  responses: "/v1/responses",
  "chat-completions": "/v1/chat/completions",
  embeddings: "/v1/embeddings",
  "anthropic-messages": "/v1/messages",
  completions: "/v1/completions",
  "image-generation": "/v1/images/generations",
  speech: "/v1/audio/speech",
  transcription: "/v1/audio/transcriptions",
  translation: "/v1/audio/translations",
  "image-edit": "/v1/images/edits",
  moderations: "/v1/moderations",
  rerank: "/v1/rerank",
  ocr: "/v1/ocr",
} as const;
export const runtimeOnlyEndpoint = (value: keyof typeof endpointPaths) =>
  value !== "responses" && value !== "chat-completions" && value !== "embeddings";
export const uploadEndpoints = new Set<keyof typeof endpointPaths>(["transcription", "translation", "image-edit"]);
