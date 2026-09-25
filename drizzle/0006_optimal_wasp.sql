ALTER TABLE "recordings" ADD COLUMN "transcript_polished" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "polish_checked_at" timestamp with time zone;