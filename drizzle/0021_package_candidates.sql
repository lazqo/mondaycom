CREATE TABLE "package_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'new' NOT NULL,
	"domain" text DEFAULT 'cctv' NOT NULL,
	"target_kit_id" uuid,
	"name" text NOT NULL,
	"key" text,
	"property_type" text DEFAULT 'residential' NOT NULL,
	"tier" text,
	"camera_count" integer,
	"storey_type" text,
	"segment" text,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"installation_package_key" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_markup_pct" numeric(6, 2),
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasoning" text,
	"confidence" numeric(4, 3),
	"status" text DEFAULT 'candidate' NOT NULL,
	"proposed_by" text NOT NULL,
	"pattern_key" text,
	"created_kit_id" uuid,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "package_candidates" ADD CONSTRAINT "package_candidates_target_kit_id_cctv_kits_id_fk" FOREIGN KEY ("target_kit_id") REFERENCES "public"."cctv_kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_candidates" ADD CONSTRAINT "package_candidates_created_kit_id_cctv_kits_id_fk" FOREIGN KEY ("created_kit_id") REFERENCES "public"."cctv_kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_candidates" ADD CONSTRAINT "package_candidates_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_candidates_status_idx" ON "package_candidates" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "package_candidates_pattern_idx" ON "package_candidates" USING btree ("pattern_key");