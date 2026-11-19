import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const auditPolicy = z.strictObject({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(90),
  contentLimit: z.number().int().min(4096).max(1024 * 1024),
  redactKeys: z.array(z.string().trim().min(1).max(100)).max(50),
});
export type AuditPolicy = z.infer<typeof auditPolicy>;

export function capture(value: unknown, settings: AuditPolicy) {
  const blocked = new Set([...settings.redactKeys, "authorization", "cookie", "set-cookie", "api_key",
    "apikey", "access_token", "refresh_token", "password", "headers"].map((entry) => entry.toLowerCase()));
  const text = JSON.stringify(value, (key, item) => blocked.has(key.toLowerCase()) ? "[REDACTED]" : item);
  const bytes = Buffer.from(text ?? "null");
  return bytes.length <= settings.contentLimit
    ? { text: bytes.toString(), state: "captured" }
    : { text: JSON.stringify({ preview: bytes.subarray(0, settings.contentLimit).toString(), truncated: true }), state: "truncated" };
}

export function contentCipher(secret: string) {
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(text: string, context: string) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    open(sealed: string, context: string) {
      const data = Buffer.from(sealed, "base64");
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
    },
  };
}

export function auditCipher(env = process.env) {
  const secret = env.MINATO_AUDIT_SECRET;
  return secret && secret.length >= 32 ? contentCipher(secret) : undefined;
}
