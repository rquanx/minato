const knownCodes: Readonly<Record<string, string>> = {
  model_not_found: "model_unavailable",
  invalid_model: "model_unavailable",
  model_unavailable: "model_unavailable",
  model_region_unavailable: "model_region_unavailable",
  context_length_exceeded: "context_length_exceeded",
  unsupported_endpoint: "unsupported_endpoint",
};

const descriptions: Readonly<Record<string, string>> = {
  model_unavailable: "The selected model is unavailable at its source.",
  model_region_unavailable: "The selected model is unavailable under the source account’s data region policy.",
  context_length_exceeded: "The request exceeds the model’s context window.",
  unsupported_endpoint: "The selected model does not support this endpoint.",
  upstream_authentication: "The source rejected its credentials or permissions.",
  upstream_rate_limited: "The source is rate limited or out of quota.",
  upstream_invalid_request: "The source rejected the request parameters.",
  upstream_unreachable: "The source could not be reached.",
  upstream_error: "The upstream request could not be completed.",
  unexpected_response: "The source returned an unexpected response.",
};

export function upstreamDescription(code: string) {
  return Object.hasOwn(descriptions, code) ? descriptions[code] : undefined;
}

export function upstreamFailure(status: number, payload: unknown) {
  const body = payload as { message?: unknown; error?: { code?: unknown; type?: unknown; message?: unknown } } | null;
  for (const value of [body?.error?.code, body?.error?.type]) {
    if (typeof value === "string" && Object.hasOwn(knownCodes, value)) return knownCodes[value];
  }
  const detail = body?.error?.message ?? body?.message;
  if ((status === 400 || status === 403) && typeof detail === "string" && /data (?:region|residency)/i.test(detail)) {
    return "model_region_unavailable";
  }
  if (status === 401 || status === 403) return "upstream_authentication";
  if (status === 429) return "upstream_rate_limited";
  if (status === 400 || status === 422) return "upstream_invalid_request";
  return "upstream_error";
}
