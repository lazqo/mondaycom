import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_TIMEZONE: z.string().default("Pacific/Auckland"),
  // Encrypts mailbox passwords at rest. Falls back to a key derived from AUTH_SECRET.
  ENCRYPTION_KEY: z.string().min(16).optional(),
  // Email ingestion: run the IMAP loop inside the web process (single-service hosting) or use the worker.
  INGEST_IN_PROCESS: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  INGEST_POLL_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
  // Calendar sync (Settings -> Calendar). An idle pass is one small request, so this can be short.
  CALENDAR_SYNC_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
