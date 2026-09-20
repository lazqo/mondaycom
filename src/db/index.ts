import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/env";

declare global {
  var __pgClient: ReturnType<typeof postgres> | undefined;
}

// Reuse the connection across hot reloads in development.
const client =
  globalThis.__pgClient ??
  postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === "production" ? 10 : 5,
    prepare: false,
  });
if (env.NODE_ENV !== "production") globalThis.__pgClient = client;

export const db = drizzle(client, { schema });
export type Db = typeof db;
export { schema };
