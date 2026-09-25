CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"server_url" text NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"calendar_url" text NOT NULL,
	"calendar_name" text,
	"push_kinds" jsonb DEFAULT '["site_visit","job","other"]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"ctag" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"event_id" uuid,
	"uid" text NOT NULL,
	"recurrence_id" text DEFAULT '' NOT NULL,
	"href" text NOT NULL,
	"etag" text,
	"origin" text NOT NULL,
	"ics" text,
	"synced_version" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "origin" text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "from_calendar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sync_sent" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sent_folder" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sent_uid_validity" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sent_last_uid" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sent_last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_items" ADD CONSTRAINT "calendar_items_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_items" ADD CONSTRAINT "calendar_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_items_uid_idx" ON "calendar_items" USING btree ("connection_id","uid","recurrence_id");--> statement-breakpoint
CREATE INDEX "calendar_items_event_idx" ON "calendar_items" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_contact_idx" ON "events" USING btree ("contact_id");--> statement-breakpoint
-- Replies sent before this column existed were all sent by the CRM itself.
UPDATE "emails" SET "origin" = 'crm' WHERE "direction" = 'outbound' AND "sent_by_id" IS NOT NULL;
