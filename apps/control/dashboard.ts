import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../../packages/contracts";
import { createAuth, type Auth, type Database } from "./auth";

const openPath = "/admin/v1/dashboard/open";
const launchPath = "/_minato/dashboard/session";
const readMethods = ["GET", "HEAD"];

function dashboardConfig(env: NodeJS.ProcessEnv) {
  if (!env.MINATO_DASHBOARD_ORIGIN && !env.MINATO_DASHBOARD_UPSTREAM) return;
  const origin = z.url({ protocol: /^https?$/ }).parse(env.MINATO_DASHBOARD_ORIGIN);
  const upstream = z.url({ protocol: /^https?$/ }).parse(env.MINATO_DASHBOARD_UPSTREAM);
  const consoleOrigin = z.url({ protocol: /^https?$/ }).parse(env.MINATO_PUBLIC_ORIGIN);
  if ([origin, upstream, consoleOrigin].some((value) => value !== new URL(value).origin) || origin === consoleOrigin) {
    throw new Error("Configure distinct Minato and Dashboard origins and a private Dashboard upstream origin");
  }
  return { origin, upstream, consoleOrigin, pepper: env.MINATO_KEY_PEPPER! };
}

async function access(db: Database) {
  const [state] = await db`select enabled, revision from dashboard_access where singleton`;
  return { enabled: Boolean(state.enabled), revision: String(state.revision) };
}

function credential(pepper: string, kind: "launch" | "access", session: string, revision: string, expires: number) {
  const payload = `${session}.${revision}.${expires}`;
  const signature = createHmac("sha256", pepper).update(`dashboard:${kind}:${payload}`).digest("hex");
  return `${payload}.${signature}`;
}

function readCredential(pepper: string, kind: "launch" | "access", value: string, revision: string) {
  const [session, version, expires, signature] = value.split(".");
  if (!/^[a-f0-9]{64}$/.test(session) || version !== revision || !/^\d{13}$/.test(expires) ||
      !/^[a-f0-9]{64}$/.test(signature) || Number(expires) <= Date.now()) return;
  const expected = credential(pepper, kind, session, revision, Number(expires));
  if (value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected))) return session;
}

export function registerDashboardSettings(app: FastifyInstance, db: Database, auth: Auth, env: NodeJS.ProcessEnv) {
  const config = dashboardConfig(env);
  const path = "/admin/v1/dashboard";
  app.get(path, async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").send({
      configured: Boolean(config), enabled: config ? (await access(db)).enabled : false,
    });
  });
  app.put(path, async (request) => {
    if (!config) throw new ApiError(409, "dashboard_unconfigured", "Configure the Dashboard listener before enabling access");
    const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body);
    await db`update dashboard_access set enabled = ${enabled}, revision = gen_random_uuid()
      where singleton and enabled <> ${enabled}`;
    return { configured: true, enabled: (await access(db)).enabled };
  });
  app.get(openPath, async (request, reply) => {
    const state = config && await access(db);
    if (!state || !state.enabled) throw new ApiError(404, "dashboard_disabled", "Dashboard access is disabled");
    const { reference } = await auth.admin(request);
    const ticket = credential(config.pepper, "launch", reference, state.revision, Date.now() + 60_000);
    const action = Bun.escapeHTML(config.origin + launchPath);
    const nonce = crypto.randomUUID();
    return reply.header("Cache-Control", "no-store")
      .header("Referrer-Policy", "strict-origin")
      .header("Content-Security-Policy", `default-src 'none'; form-action ${config.origin}; script-src 'nonce-${nonce}'; frame-ancestors 'none'`)
      .type("text/html; charset=utf-8").send(`<!doctype html><html lang="en"><title>Open LiteLLM Dashboard</title>
      <form method="post" action="${action}"><input type="hidden" name="ticket" value="${ticket}">
      <button>Continue to LiteLLM Dashboard</button></form><script nonce="${nonce}">document.forms[0].submit()</script></html>`);
  });
}

export function createDashboardListener(db: Database, env: NodeJS.ProcessEnv) {
  const config = dashboardConfig(env);
  if (!config) return;
  const { origin, upstream, consoleOrigin, pepper } = config;
  const auth = createAuth(db, pepper, "", false);
  const app = Fastify({ bodyLimit: 8 * 1024 * 1024, disableRequestLogging: true });
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ message: error.message });
    return reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 502)
      .send({ message: "Dashboard request failed" });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "same-origin");
    const state = await access(db);
    if (!state.enabled) throw new ApiError(404, "dashboard_disabled", "Dashboard access is disabled");
    const launch = request.routeOptions.url === launchPath && request.method === "POST";
    const requestOrigin = request.headers.origin;
    if (!readMethods.includes(request.method) && (launch ? requestOrigin !== consoleOrigin : requestOrigin !== origin)) {
      throw new ApiError(403, "invalid_origin", "Origin does not match");
    }
    if (launch) return;
    const cookie = /(?:^|;\s*)minato_dashboard=([\w.-]+)(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
    const session = cookie && readCredential(pepper, "access", cookie, state.revision);
    if (!session || await auth.sessionMember(session) !== null) {
      throw new ApiError(401, "unauthenticated", "Open the Dashboard from the Minato administrator console");
    }
  });
  app.post(launchPath, { bodyLimit: 4096 }, async (request, reply) => {
    const ticket = new URLSearchParams(String(request.body ?? "")).get("ticket");
    const state = await access(db);
    const session = state.enabled && ticket && readCredential(pepper, "launch", ticket, state.revision);
    if (!session || await auth.sessionMember(session) !== null) {
      throw new ApiError(401, "unauthenticated", "Open the Dashboard from the Minato administrator console");
    }
    const lifetime = 8 * 60 * 60;
    const cookie = credential(pepper, "access", session, state.revision, Date.now() + lifetime * 1000);
    return reply.header("Set-Cookie", `minato_dashboard=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure}`)
      .redirect("/ui/", 303);
  });
  app.all("/*", async (request, reply) => {
    const headers = new Headers();
    for (const name of ["accept", "authorization", "content-type", "range"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const cookie = /(?:^|;\s*)token=([^;\s]+)(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
    if (cookie) headers.set("Cookie", `token=${cookie}`);
    const response = await fetch(upstream + request.url, {
      method: request.method, headers, redirect: "manual",
      body: readMethods.includes(request.method) ? undefined : request.body as Buffer | undefined,
      signal: AbortSignal.timeout(120_000),
    });
    for (const name of ["content-type", "content-disposition", "content-range", "accept-ranges", "content-security-policy"]) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }
    const location = response.headers.get("location");
    if (location) {
      const target = new URL(location, upstream + request.url);
      if (target.origin !== upstream && target.origin !== origin) {
        await response.body?.cancel();
        throw new ApiError(502, "invalid_dashboard_redirect", "Dashboard returned a redirect outside its origin");
      }
      reply.header("Location", origin + target.pathname + target.search + target.hash);
    }
    const cookies = response.headers.getSetCookie().filter((value) => value.startsWith("token="));
    if (cookies.length) reply.header("Set-Cookie", cookies);
    return reply.code(response.status).send(response.body ? Readable.fromWeb(response.body) : undefined);
  });
  return app;
}
