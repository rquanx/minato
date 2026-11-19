import assert from "node:assert/strict";
import { startSse } from "../apps/ingress/inference";

const encode = (value: string) => new TextEncoder().encode(value);
let wasCancelled = false;
const source = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fixture"}\n\n'));
  },
  cancel() { wasCancelled = true; },
});
const stream = await startSse(source, "demo.production.classify");
const reader = stream.getReader();
assert.match(new TextDecoder().decode((await reader.read()).value), /fixture/);
await reader.cancel();
assert(wasCancelled, "Client cancellation must propagate to the upstream reader");

const oversized = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encode("data: " + "x".repeat(256 * 1024) + "\n\n"));
    controller.close();
  },
});
await assert.rejects(() => startSse(oversized, "demo.production.classify"), /SSE frame exceeds buffer limit/);
console.log("Verified upstream reader cancellation and SSE frame limit.");
