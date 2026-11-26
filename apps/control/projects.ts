import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, namedResource, slug, uuid } from "../../packages/contracts";
import type { Auth, Database } from "./auth";

const projectPath = z.object({ project: slug });
const environmentPath = projectPath.extend({ env: slug });
const keyPath = environmentPath.extend({ id: uuid });
const keyInput = z.strictObject({
  label: z.string().trim().min(1).max(160),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export function registerProjects(app: FastifyInstance, db: Database, auth: Auth) {
  app.get("/admin/v1/project-archives", async () => ({
    projects: await db`select slug, display_name as "displayName" from projects where archived_at is not null order by slug`,
    environments: await db`select p.slug as project, e.slug, e.display_name as "displayName" from environments e
      join projects p on p.id = e.project_id where e.archived_at is not null order by p.slug, e.slug`,
  }));
  const lifecycle = z.strictObject({ displayName: namedResource.shape.displayName.optional(), archived: z.boolean().optional() });
  app.patch("/admin/v1/projects/:project", async (request) => {
    const { project } = projectPath.parse(request.params);
    const input = lifecycle.parse(request.body);
    const [row] = await db`update projects set display_name = coalesce(${input.displayName ?? null}, display_name),
      archived_at = case when ${input.archived ?? null}::boolean is true then coalesce(archived_at,now())
        when ${input.archived ?? null}::boolean is false then null else archived_at end
      where slug = ${project} returning id, slug, display_name as "displayName", archived_at as "archivedAt"`;
    if (!row) throw new ApiError(404, "project_not_found", "Project not found");
    return row;
  });
  app.patch("/admin/v1/projects/:project/environments/:env", async (request) => {
    const { project, env } = environmentPath.parse(request.params);
    const input = lifecycle.parse(request.body);
    const [row] = await db`update environments e set display_name = coalesce(${input.displayName ?? null}, e.display_name),
      archived_at = case when ${input.archived ?? null}::boolean is true then coalesce(e.archived_at,now())
        when ${input.archived ?? null}::boolean is false then null else e.archived_at end
      from projects p where p.id = e.project_id and p.slug = ${project} and e.slug = ${env}
      returning e.id,e.slug,e.display_name as "displayName",e.archived_at as "archivedAt"`;
    if (!row) throw new ApiError(404, "environment_not_found", "Environment not found");
    return row;
  });
  async function environmentId(project: string, env: string) {
    const [row] = await db`select e.id from environments e join projects p on p.id = e.project_id
      where p.slug = ${project} and e.slug = ${env}
      and p.archived_at is null and e.archived_at is null`;
    if (!row) throw new ApiError(404, "environment_not_found", "Environment not found");
    return String(row.id);
  }

  app.get("/admin/v1/projects", async (request) =>
    db`select id, slug, display_name as "displayName", created_at as "createdAt"
      from projects p where archived_at is null and (${request.memberId}::uuid is null or exists (
        select 1 from environments e join environment_memberships em on em.environment_id = e.id
        where e.project_id = p.id and em.member_id = ${request.memberId}))
      order by created_at desc, id desc limit 200`);

  app.post("/admin/v1/projects", async (request, reply) => {
    const input = namedResource.parse(request.body);
    const result = await db.begin(async (tx) => {
      const [project] = await tx`insert into projects (slug, display_name)
        values (${input.slug}, ${input.displayName}) returning id, slug, display_name as "displayName"`;
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'project.created', ${project.id})`;
      return project;
    });
    return reply.code(201).send(result);
  });

  app.get("/admin/v1/projects/:project/environments", async (request) => {
    const { project } = projectPath.parse(request.params);
    return db`select e.id, e.slug, e.display_name as "displayName", e.created_at as "createdAt"
      from environments e join projects p on p.id = e.project_id
      where p.slug = ${project} and p.archived_at is null and e.archived_at is null
      and (${request.memberId}::uuid is null or exists (select 1 from environment_memberships em
        where em.environment_id = e.id and em.member_id = ${request.memberId}))
      order by e.created_at desc, e.id desc limit 200`;
  });

  app.post("/admin/v1/projects/:project/environments", async (request, reply) => {
    const { project } = projectPath.parse(request.params);
    const input = namedResource.parse(request.body);
    const result = await db.begin(async (tx) => {
      const [row] = await tx`insert into environments (project_id, slug, display_name)
        select id, ${input.slug}, ${input.displayName} from projects
        where slug = ${project} and archived_at is null
        returning id, slug, display_name as "displayName"`;
      if (!row) throw new ApiError(404, "project_not_found", "Project not found");
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'environment.created', ${row.id})`;
      return row;
    });
    return reply.code(201).send(result);
  });

  app.get("/admin/v1/projects/:project/environments/:env/keys", async (request) => {
    const { project, env } = environmentPath.parse(request.params);
    const id = await environmentId(project, env);
    return db`select id, label, expires_at as "expiresAt", revoked_at as "revokedAt", created_at as "createdAt"
      from environment_keys where environment_id = ${id} order by created_at desc, id desc limit 200`;
  });

  app.post("/admin/v1/projects/:project/environments/:env/keys", async (request, reply) => {
    const { project, env } = environmentPath.parse(request.params);
    const id = await environmentId(project, env);
    const input = keyInput.parse(request.body);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) throw new ApiError(422, "invalid_expiry", "Key expiry must be in the future");
    const key = auth.makeKey();
    const record = await db.begin(async (tx) => {
      const [row] = await tx`insert into environment_keys (environment_id, public_key_id, digest, label, expires_at)
        values (${id}, ${key.publicId}, ${key.digest}, ${input.label}, ${expiresAt})
        returning id, label, expires_at as "expiresAt"`;
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'key.issued', ${row.id})`;
      return row;
    });
    return reply.header("Cache-Control", "no-store").code(201).send({ ...record, key: key.secret });
  });

  app.delete("/admin/v1/projects/:project/environments/:env/keys/:id", async (request, reply) => {
    const { project, env, id } = keyPath.parse(request.params);
    const environment = await environmentId(project, env);
    await db.begin(async (tx) => {
      const [changed] = await tx`update environment_keys set revoked_at = now()
        where id = ${id} and environment_id = ${environment} and revoked_at is null returning id`;
      if (changed) await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'key.revoked', ${id})`;
    });
    return reply.code(204).send();
  });
}
