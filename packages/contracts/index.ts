import { z } from "zod";

export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/);
export const uuid = z.uuid();
export const displayName = z.string().trim().min(1).max(160);
export const endpoint = z.enum(["responses", "chat-completions", "embeddings"]);
export const namedResource = z.strictObject({ slug, displayName });
export const modelReference = z.strictObject({
  sourceId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(256),
});
export const featureDeclaration = z.strictObject({
  displayName,
  preferredModel: modelReference.optional(),
  requirements: z.strictObject({
    endpoint,
    minContextTokens: z.number().int().positive().optional(),
    structuredOutput: z.enum(["json_object", "json_schema"]).optional(),
    streaming: z.boolean().optional(),
    tools: z.boolean().optional(),
  }),
});

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
