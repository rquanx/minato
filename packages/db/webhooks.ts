import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { BlockList } from "node:net";
import { auditCipher } from "./audit";
import type { connectDatabase } from "./client";

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, prefix);

export function webhookUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Provide an HTTPS Webhook URL");
  return url;
}

async function publicIPv4(host: string) {
  const addresses = await resolve4(host);
  if (!addresses.length || addresses.some((address) => nonPublic.check(address))) {
    throw new Error("Webhook must resolve to a public IPv4 address");
  }
  return addresses[0];
}

export async function webhookTarget(db: ReturnType<typeof connectDatabase>, env: NodeJS.ProcessEnv, channel: string) {
  if (!channel.startsWith("webhook:")) return { url: webhookUrl(env[channel] ?? ""), managed: false };
  const id = channel.slice(8);
  const [entry] = await db`select sealed_url from notification_webhooks where id = ${id}`;
  const cipher = auditCipher(env);
  if (!entry || !cipher) throw new Error("Webhook channel is unavailable");
  return { url: webhookUrl(cipher.open(entry.sealed_url, `webhook:${id}`)), managed: true };
}

export async function postWebhook(target: { url: URL; managed: boolean }, id: string, payload: unknown) {
  const headers = { "Content-Type": "application/json", "Idempotency-Key": id };
  const body = JSON.stringify(payload);
  const signal = AbortSignal.timeout(8_000);
  if (!target.managed) {
    const response = await fetch(target.url, { method: "POST", redirect: "manual", signal, headers, body });
    await response.body?.cancel();
    return response.status;
  }
  const address = await publicIPv4(target.url.hostname);
  return new Promise<number>((resolve, reject) => {
    // Pin the validated address while retaining the destination hostname for TLS verification.
    const outbound = request({
      host: address, port: target.url.port || 443, servername: target.url.hostname,
      path: target.url.pathname + target.url.search, method: "POST", signal, agent: false,
      headers: { ...headers, Host: target.url.host, "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      resolve(response.statusCode ?? 502);
      response.destroy();
    });
    outbound.once("error", reject);
    outbound.end(body);
  });
}
