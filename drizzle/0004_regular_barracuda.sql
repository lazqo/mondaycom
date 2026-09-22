CREATE TYPE "public"."recording_status" AS ENUM('review', 'attached', 'dismissed');--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"source" text DEFAULT 'plaud' NOT NULL,
	"title" text NOT NULL,
	"transcript" text NOT NULL,
	"recorded_at" timestamp with time zone,
	"duration_seconds" integer,
	"status" "recording_status" DEFAULT 'review' NOT NULL,
	"contact_id" uuid,
	"lead_id" uuid,
	"matched_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_external_idx" ON "recordings" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "recordings_status_idx" ON "recordings" USING btree ("status","recorded_at");--> statement-breakpoint
CREATE INDEX "recordings_contact_idx" ON "recordings" USING btree ("contact_id");