// Runs pending SQL migrations from ./drizzle. Plain JS so it works in the production image.
import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (existsSync(".env")) {
  const { config } = await import("dotenv");
  config();
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = postgres(url, { max: 1, onnotice: () => {}, ssl: /sslmode=require/.test(url) ? "require" : undefined });
const db = drizzle(client);
console.log("Running migrations…");
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations complete.");
await client.end();
