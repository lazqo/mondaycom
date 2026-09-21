CREATE TYPE "public"."email_classification" AS ENUM('pending', 'lead', 'needs_review', 'not_lead', 'existing', 'outbound', 'error');--> statement-breakpoint
CREATE TYPE "public"."email_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."lead_urgency" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TABLE "email_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"content_id" text,
	"content" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"is_lead" boolean NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"result" jsonb NOT NULL,
	"raw_response" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"normalized_subject" text DEFAULT '' NOT NULL,
	"counterpart_address" text,
	"first_message_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" "email_direction" DEFAULT 'inbound' NOT NULL,
	"message_id" text NOT NULL,
	"in_reply_to" text,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imap_uid" integer,
	"from_name" text,
	"from_address" text DEFAULT '' NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"text_body" text,
	"html_body" text,
	"snippet" text,
	"raw_mime" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"classification" "email_classification" DEFAULT 'pending' NOT NULL,
	"classification_error" text,
	"classified_at" timestamp with time zone,
	"lead_id" uuid,
	"contact_id" uuid,
	"sent_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email_address" text NOT NULL,
	"provider" text DEFAULT 'titan' NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer DEFAULT 465 NOT NULL,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"uid_validity" text,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "urgency" "lead_urgency";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "next_action" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ai_confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "email_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "source_email_id" uuid;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_attachments_email_idx" ON "email_attachments" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "email_classifications_email_idx" ON "email_classifications" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "email_threads_mailbox_idx" ON "email_threads" USING btree ("mailbox_id","last_message_at");--> statement-breakpoint
CREATE INDEX "email_threads_lead_idx" ON "email_threads" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "email_threads_contact_idx" ON "email_threads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "email_threads_subject_idx" ON "email_threads" USING btree ("mailbox_id","normalized_subject","counterpart_address");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_mailbox_message_id_idx" ON "emails" USING btree ("mailbox_id","message_id");--> statement-breakpoint
CREATE INDEX "emails_thread_idx" ON "emails" USING btree ("thread_id","received_at");--> statement-breakpoint
CREATE INDEX "emails_received_idx" ON "emails" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "emails_classification_idx" ON "emails" USING btree ("classification");--> statement-breakpoint
CREATE INDEX "emails_from_idx" ON "emails" USING btree ("from_address");