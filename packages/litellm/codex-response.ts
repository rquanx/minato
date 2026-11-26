export function codexRequest(input: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...input, stream: true, store: false,
    instructions: typeof input.instructions === "string" ? input.instructions : "",
    input: typeof input.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: input.input }] }] : input.input };
  for (const field of ["max_output_tokens", "temperature", "top_p", "truncation", "previous_response_id"]) delete body[field];
  return body;
}

export async function codexResult(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, lineEnd).trimEnd();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { continue; }
      if (["response.completed", "response.incomplete"].includes(event?.type) && event.response) return event.response;
      if (event?.type === "response.failed" || event?.type === "error") return;
    }
    if (buffer.length > 2 * 1024 * 1024) break;
  }
}
