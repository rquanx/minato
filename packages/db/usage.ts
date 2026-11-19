import type { connectDatabase } from "./client";

export async function saveUsage(db: ReturnType<typeof connectDatabase>, attemptId: string, value: unknown) {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, any>;
  function token(input: unknown) {
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null;
  }
  const input = token(usage.input_tokens ?? usage.prompt_tokens);
  const output = token(usage.output_tokens ?? usage.completion_tokens);
  const total = token(usage.total_tokens);
  const cached = token(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const reasoning = token(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens);
  if ([input, output, total, cached, reasoning].every((value) => value === null)) return;
  await db`insert into attempt_usage (attempt_id, input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens)
    values (${attemptId}, ${input}, ${output}, ${total}, ${cached}, ${reasoning})
    on conflict (attempt_id) do update set
      input_tokens = coalesce(excluded.input_tokens, attempt_usage.input_tokens),
      output_tokens = coalesce(excluded.output_tokens, attempt_usage.output_tokens),
      total_tokens = coalesce(excluded.total_tokens, attempt_usage.total_tokens),
      cached_tokens = coalesce(excluded.cached_tokens, attempt_usage.cached_tokens),
      reasoning_tokens = coalesce(excluded.reasoning_tokens, attempt_usage.reasoning_tokens)`;
}
