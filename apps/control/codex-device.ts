import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { credentialCipher } from "../../packages/db/source-credentials";
import { beginCodexLogin, codexLoginUrl, pollCodexLogin } from "../../packages/litellm/codex-auth";
import type { TokenBundle } from "../../packages/litellm/provider-auth";
import type { Auth, Database } from "./auth";
import { beginKimiLogin, pollKimiLogin } from "../../packages/litellm/subscription-auth";

export function registerCodexDevice(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv, auth: Auth,
  attach: (sourceId: string, revision: number, tokens: TokenBundle, type: string) => Promise<unknown>) {
  const cipher = credentialCipher(env);
  for (const provider of ["codex", "kimi"] as const) {
  const path = `/admin/v1/sources/:id/${provider}-login`;
  app.post(path, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    if (!cipher || env.MINATO_DATA_PLANE !== "runtime") throw new ApiError(422, "device_login_runtime_required", "Configure encrypted credentials and the Go Runtime");
    const [source] = await db`select revision from sources where id = ${id} and kind = ${provider}`;
    if (!source) throw new ApiError(404, "source_not_found", "Device-login source not found");
    const { reference } = await auth.admin(request);
    const flow = await (provider === "kimi" ? beginKimiLogin() : beginCodexLogin().then((session) => ({
      ...session, verificationUrl: codexLoginUrl, expiresIn: 900,
    }))).catch(() => {
      throw new ApiError(502, "device_login_unavailable", "Provider device sign-in could not start");
    });
    const sessionId = crypto.randomUUID();
    const expiration = new Date(Date.now() + flow.expiresIn * 1000);
    await db`delete from provider_device_sessions where expires_at < now() or (source_id = ${id} and session_ref = ${reference})`;
    await db`insert into provider_device_sessions (id, source_id, source_revision, session_ref, sealed, poll_after, expires_at)
      values (${sessionId}, ${id}, ${source.revision}, ${reference}, ${cipher.seal(JSON.stringify(flow), sessionId)},
        ${new Date(Date.now() + flow.interval * 1000)}, ${expiration})`;
    return reply.header("Cache-Control", "no-store").send({
      sessionId, userCode: flow.userCode, verificationUrl: flow.verificationUrl, interval: flow.interval, expiresAt: expiration,
    });
  });
  app.post(path + "/:sessionId", async (request, reply) => {
    const { id, sessionId } = z.object({ id: uuid, sessionId: uuid }).parse(request.params);
    const { reference } = await auth.admin(request);
    if (!cipher) throw new ApiError(422, "credential_storage_unavailable", "Configure encrypted credentials");
    const [flow] = await db`update provider_device_sessions d set poll_after = now() + interval '30 seconds'
      from sources s where d.id = ${sessionId} and d.source_id = ${id} and d.session_ref = ${reference}
      and d.expires_at > now() and d.poll_after <= now() and s.id = d.source_id and s.revision = d.source_revision and s.kind = ${provider}
      returning d.sealed, d.source_revision`;
    if (!flow) {
      const [pending] = await db`select 1 from provider_device_sessions d join sources s on s.id = d.source_id
        where d.id = ${sessionId} and d.source_id = ${id} and d.session_ref = ${reference}
        and d.expires_at > now() and s.revision = d.source_revision`;
      return reply.header("Cache-Control", "no-store").send({ status: pending ? "pending" : "expired" });
    }
    const session = JSON.parse(cipher.open(flow.sealed, sessionId)) as Awaited<ReturnType<typeof beginCodexLogin>>
      & { deviceCode: string };
    let tokens;
    try {
      if (provider === "kimi") {
        const result = await pollKimiLogin(session);
        if (result.status === "expired") {
          await db`delete from provider_device_sessions where id = ${sessionId}`;
          return reply.header("Cache-Control", "no-store").send({ status: "expired" });
        }
        if (result.status === "slow_down") {
          session.interval += 5;
          await db`update provider_device_sessions set sealed = ${cipher.seal(JSON.stringify(session), sessionId)} where id = ${sessionId}`;
        }
        if (result.status === "connected") tokens = result.tokens;
      } else tokens = await pollCodexLogin(session.deviceId, session.userCode);
    }
    catch {
      await db`update provider_device_sessions set poll_after = now() + interval '10 seconds' where id = ${sessionId}`;
      throw new ApiError(502, "device_login_poll_failed", "Provider did not respond. Check again shortly");
    }
    if (!tokens) {
      await db`update provider_device_sessions set poll_after = ${new Date(Date.now() + session.interval * 1000)} where id = ${sessionId}`;
      return reply.header("Cache-Control", "no-store").send({ status: "pending" });
    }
    await attach(id, flow.source_revision, tokens, "oauth");
    await db`delete from provider_device_sessions where id = ${sessionId}`;
    return reply.header("Cache-Control", "no-store").send({ status: "connected" });
  });
  }
}
