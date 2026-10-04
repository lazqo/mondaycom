CREATE TABLE "agent_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent" text NOT NULL,
	"tool" text NOT NULL,
	"access" text NOT NULL,
	"status" text NOT NULL,
	"args" jsonb,
	"result_summary" text,
	"error" text,
	"lead_id" uuid,
	"contact_id" uuid,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspector_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid,
	"run_id" uuid,
	"lead_id" uuid,
	"contact_id" uuid,
	"kind" text NOT NULL,
	"subject" text,
	"hermes_recommendation" text,
	"value" jsonb,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspector_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"runtime" text,
	"model" text,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"context_refs" jsonb NOT NULL,
	"result" jsonb,
	"raw_excerpt" text,
	"error" text,
	"duration_ms" integer,
	"confidence" numeric(4, 3),
	"recommended_action" text,
	"reason" text,
	"validation" jsonb,
	"brain_result" jsonb,
	"final_actions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "engine" text DEFAULT 'rules' NOT NULL;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "hermes" jsonb;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "rules_view" jsonb;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "review_kind" text;--> statement-breakpoint
ALTER TABLE "inspector_feedback" ADD CONSTRAINT "inspector_feedback_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_feedback" ADD CONSTRAINT "inspector_feedback_run_id_inspector_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."inspector_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_feedback" ADD CONSTRAINT "inspector_feedback_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_feedback" ADD CONSTRAINT "inspector_feedback_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_feedback" ADD CONSTRAINT "inspector_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_runs" ADD CONSTRAINT "inspector_runs_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_audit_created_idx" ON "agent_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_audit_lead_idx" ON "agent_audit" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "inspector_feedback_lead_idx" ON "inspector_feedback" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "inspector_feedback_kind_idx" ON "inspector_feedback" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inspector_queue_source_idx" ON "inspector_queue" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "inspector_queue_next_idx" ON "inspector_queue" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "inspector_runs_source_idx" ON "inspector_runs" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "inspector_runs_inspection_idx" ON "inspector_runs" USING btree ("inspection_id");