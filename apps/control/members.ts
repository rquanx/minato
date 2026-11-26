import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError, slug, uuid } from "../../packages/contracts";
import type { Database } from "./auth";

const params = z.object({ id: uuid });
export async function authorizeMember(db: Database, request: FastifyRequest, memberId: string) {
  const route = request.routeOptions.url ?? "";
  const method = request.method;
  if (route === "/admin/v1/session" || (method === "GET" && [
    "/admin/v1/projects", "/admin/v1/projects/:project/environments",
  ].includes(route))) return;
  const scope = params.safeParse(request.params);
  if (scope.success) {
    const { id } = scope.data;
    let environment = id;
    let permission = "usage";
    if (method === "GET" && ["/admin/v1/calls/:id", "/admin/v1/calls/:id/content"].includes(route)) {
      const [call] = await db`select environment_id from calls where request_id = ${id}`;
      environment = call?.environment_id;
      if (route.endsWith("/content")) permission = "content";
    } else if (route === "/admin/v1/tests/:id" && method === "GET") {
      const [test] = await db`select environment_id, actor from tests where id = ${id}`;
      environment = test?.actor === memberId ? test.environment_id : "";
      permission = "test";
    } else if (route === "/admin/v1/environments/:id/tests" && method === "POST") {
      permission = (request.body as { replayOf?: unknown } | null)?.replayOf ? "replay" : "test";
    } else if (method !== "GET" || !["/admin/v1/environments/:id/calls", "/admin/v1/environments/:id/usage",
      "/admin/v1/environments/:id/features"].includes(route)) {
      environment = "";
    }
    if (environment) {
      const [grant] = await db`select can_usage, can_content, can_test from environment_memberships
        where environment_id = ${environment} and member_id = ${memberId}`;
      if (grant && (permission === "test" ? grant.can_test : permission === "replay" ? grant.can_test && grant.can_content
        : permission === "content" ? grant.can_content : grant.can_usage)) return;
    }
  }
  throw new ApiError(403, "insufficient_permissions", "This account does not have access to the requested resource");
}

export function registerMembers(app: FastifyInstance, db: Database) {
  app.post("/admin/v1/members", async (request, reply) => {
    const { username, password } = z.strictObject({ username: slug, password: z.string().min(12).max(1024) }).parse(request.body);
    const hash = await Bun.password.hash(password);
    const [record] = await db`insert into members (username, password_hash) values (${username}, ${hash}) returning id, username`;
    return reply.code(201).send(record);
  });
  app.get("/admin/v1/members", async () => db`select id, username from members order by username limit 200`);
  app.delete("/admin/v1/members/:id/sessions", async (request, reply) => {
    const { id } = params.parse(request.params);
    await db`delete from admin_sessions where member_id = ${id}`;
    return reply.code(204).send();
  });
  app.get("/admin/v1/environments/:id/members", async (request) => {
    const { id } = params.parse(request.params);
    return db`select member_id as id, can_usage as usage, can_content as content, can_test as test
      from environment_memberships where environment_id = ${id}`;
  });
  app.put("/admin/v1/environments/:id/members/:member", async (request) => {
    const { id, member } = params.extend({ member: uuid }).parse(request.params);
    const input = z.strictObject({ usage: z.boolean(), content: z.boolean(), test: z.boolean() })
      .refine((entry) => !entry.content || entry.usage).parse(request.body);
    await db.begin(async (tx) => {
      await tx`insert into environment_memberships (environment_id, member_id, can_usage, can_content, can_test)
        values (${id}, ${member}, ${input.usage}, ${input.content}, ${input.test})
        on conflict (environment_id, member_id) do update set can_usage = excluded.can_usage,
          can_content = excluded.can_content, can_test = excluded.can_test`;
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'environment.membership_changed', ${id})`;
    });
    return input;
  });
}
