import { SQL } from "bun";

export function connectDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is required");
  return new SQL(url, { max: 10 });
}
