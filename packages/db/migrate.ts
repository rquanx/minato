import { readdir } from "node:fs/promises";
import { connectDatabase } from "./client";

const db = connectDatabase();
const directory = new URL("./migrations/", import.meta.url);
try {
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(48492197)`;
    await tx`create table if not exists schema_migrations (
      filename text primary key, applied_at timestamptz not null default now()
    )`;
    const files = (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
    for (const file of files) {
      const [applied] = await tx`select filename from schema_migrations where filename = ${file}`;
      if (applied) continue;
      await tx.unsafe(await Bun.file(new URL(file, directory)).text()).simple();
      await tx`insert into schema_migrations (filename) values (${file})`;
      console.log(`Applied ${file}`);
    }
  });
} finally {
  await db.close();
}
