import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../../packages/contracts";
import type { connectDatabase } from "../../packages/db/client";

export type Database = ReturnType<typeof connectDatabase>;
const sessionLifetime = 8 * 60 * 60;

export function createAuth(db: Database, pepper: string, password: string, secure: boolean) {
  const digest = (value: string) => createHmac("sha256", pepper).update(value).digest("hex");
  const matches = (value: string, expected: string) =>
    /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(expected, "hex"));
  const sessionDigest = (value: string) => digest(`session:${value}`);
  const cookie = (value: string, lifetime: number) =>
    `minato_session=${value}; Path=/admin/v1; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${secure ? "; Secure" : ""}`;
  async function sessionMember(sessionDigest: string) {
    const [record] = await db`select member_id from admin_sessions
      where digest = ${sessionDigest} and expires_at > now()`;
    if (!record) throw new ApiError(401, "unauthenticated", "Administrator session expired");
    return record.member_id as string | null;
  }

  return {
    async login(candidate: string, username?: string) {
      let memberId: string | null = null;
      if (username) {
        const [member] = await db`select id, password_hash from members where username = ${username}`;
        if (!member || !(await Bun.password.verify(candidate, member.password_hash))) {
          throw new ApiError(401, "invalid_credentials", "Invalid sign-in credentials");
        }
        memberId = member.id;
      } else if (!matches(candidate, digest(password))) {
        throw new ApiError(401, "invalid_credentials", "Invalid sign-in credentials");
      }
      const token = randomBytes(32).toString("hex");
      await db`insert into admin_sessions (digest, expires_at, member_id)
        values (${sessionDigest(token)}, ${new Date(Date.now() + sessionLifetime * 1000)}, ${memberId})`;
      return cookie(token, sessionLifetime);
    },
    async admin(request: FastifyRequest) {
      const session = /(?:^|;\s*)minato_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
      if (!session) throw new ApiError(401, "unauthenticated", "Administrator session required");
      const reference = sessionDigest(session);
      const memberId = await sessionMember(reference);
      return { session, reference, memberId, csrfToken: digest(`csrf:${session}`) };
    },
    sessionMember,
    async logout(session: string) {
      await db`delete from admin_sessions where digest = ${sessionDigest(session)}`;
      return cookie("", 0);
    },
    makeKey() {
      const publicId = randomBytes(12).toString("hex");
      const secret = `mn_${publicId}_${randomBytes(32).toString("hex")}`;
      return { publicId, secret, digest: digest(secret) };
    },
    async environment(request: FastifyRequest) {
      const secret = /^Bearer (mn_([a-f0-9]{24})_[a-f0-9]{64})$/i.exec(request.headers.authorization ?? "");
      if (!secret) throw new ApiError(401, "invalid_api_key", "Environment API key required");
      const [identity] = await db`select k.digest, e.id, p.slug as project, e.slug as environment
        from environment_keys k join environments e on e.id = k.environment_id
        join projects p on p.id = e.project_id
        where k.public_key_id = ${secret[2]} and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
        and e.archived_at is null and p.archived_at is null`;
      if (!identity || !matches(secret[1], identity.digest)) {
        throw new ApiError(401, "invalid_api_key", "Invalid environment API key");
      }
      return { id: String(identity.id), project: String(identity.project), environment: String(identity.environment) };
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
