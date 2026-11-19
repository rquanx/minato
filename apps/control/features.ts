import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError, featureDeclaration, slug } from "../../packages/contracts";
import type { Auth, Database } from "./auth";

const featurePath = "/minato/v1/projects/:project/environments/:env/features/:feature";
const params = z.object({ project: slug, env: slug, feature: slug });

export function registerFeatures(app: FastifyInstance, db: Database, auth: Auth) {
  async function scope(request: FastifyRequest) {
    const { project, env, feature } = params.parse(request.params);
    const identity = await auth.environment(request);
    if (project !== identity.project || env !== identity.environment) {
      throw new ApiError(403, "environment_scope", "Environment does not match this key");
    }
    return { environment: identity.id, feature, alias: `${project}.${env}.${feature}` };
  }

  app.put(featurePath, async (request, reply) => {
    const { environment, feature, alias } = await scope(request);
    const declaration = JSON.stringify(featureDeclaration.parse(request.body));
    const [row] = await db`insert into features (environment_id, slug, alias, declaration)
      values (${environment}, ${feature}, ${alias}, ${declaration}::text::jsonb)
      on conflict (environment_id, slug) do update set
        registration_revision = features.registration_revision +
          case when features.declaration is distinct from excluded.declaration then 1 else 0 end,
        declaration = excluded.declaration,
        reconcile_needed = features.reconcile_needed or
          (features.approved_policy is not null and features.declaration is distinct from excluded.declaration)
      returning alias, registration_revision as "registrationRevision", active_version::text as "activeRouteVersion",
        (xmax = 0) as inserted`;
    const { inserted, ...featureView } = row;
    return reply.code(inserted ? 201 : 200).send({ ...featureView,
      routingStatus: row.activeRouteVersion ? "active" : "pending" });
  });

  app.get(featurePath, async (request) => {
    const { environment, feature } = await scope(request);
    const [row] = await db`select alias, registration_revision as "registrationRevision",
      declaration->'requirements' as requirements, active_version::text as "activeRouteVersion",
      desired_version::text as "desiredRouteVersion"
      from features where environment_id = ${environment} and slug = ${feature}`;
    if (!row) throw new ApiError(404, "feature_not_found", "Feature not found");
    return { ...row, routingStatus: row.activeRouteVersion ? "active" : "pending" };
  });
}
