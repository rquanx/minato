import { googleSubscription, providerUrls, type ProviderKind } from "../contracts/providers";
import type { TokenBundle } from "./provider-auth";
import { claudeHeaders, kimiHeaders } from "./subscription-auth";

export function subscriptionRequest(kind: string, model: string, payload: unknown, bundle: Pick<TokenBundle, "accessToken" | "projectId" | "deviceId">,
  stream: boolean, signal: AbortSignal) {
  const base = providerUrls[kind as ProviderKind]!.base;
  let url: string;
  let headers: Record<string, string> = { authorization: "Bearer " + bundle.accessToken };
  let body = payload;
  if (googleSubscription(kind)) {
    if (!bundle.projectId) throw new Error("google_project_unavailable");
    url = base + (stream ? "/v1internal:streamGenerateContent?alt=sse" : "/v1internal:generateContent");
    body = { model, project: bundle.projectId, request: payload,
      ...(kind === "antigravity" ? { userAgent: "antigravity", requestId: "agent-" + crypto.randomUUID(), requestType: "agent" } : {}) };
  } else if (kind === "claude") {
    url = base + "/messages?beta=true";
    headers = claudeHeaders(bundle.accessToken);
  } else {
    if (!bundle.deviceId) throw new Error("kimi_device_unavailable");
    url = base + "/chat/completions";
    headers = { ...headers, ...kimiHeaders(bundle.deviceId) };
  }
  return fetch(url, { method: "POST", redirect: "error", signal, body: JSON.stringify(body),
    headers: { ...headers, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" } });
}

export function unwrapCloudResponse(value: any) {
  return value?.response ?? value;
}

export function unwrapCloudStream(body: ReadableStream<Uint8Array>) {
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
    transform(chunk, output) {
      pending += chunk;
      let end = pending.indexOf("\n");
      while (end >= 0) {
        let line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.startsWith("data:")) {
          try { line = "data: " + JSON.stringify(unwrapCloudResponse(JSON.parse(line.slice(5)))); }
          catch { /* Forward upstream event markers. */ }
        }
        output.enqueue(encoder.encode(line + "\n"));
        end = pending.indexOf("\n");
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error("cloud_event_too_large");
    },
    flush(output) { if (pending.trim()) output.enqueue(encoder.encode(pending)); },
  }));
}
