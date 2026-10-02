CREATE TYPE "public"."draft_status" AS ENUM('draft', 'ready_for_review', 'approved', 'revision_requested', 'rejected', 'sent', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('industry_fact', 'manufacturer_verified', 'getsecure_approved', 'getsecure_provisional', 'historical_reference', 'requires_review', 'deprecated');--> statement-breakpoint
ALTER TYPE "public"."quote_status" ADD VALUE 'ai_prepared';--> statement-breakpoint
ALTER TYPE "public"."quote_status" ADD VALUE 'needs_review';--> statement-breakpoint
ALTER TYPE "public"."quote_status" ADD VALUE 'approved';--> statement-breakpoint
ALTER TYPE "public"."quote_status" ADD VALUE 'superseded';--> statement-breakpoint
CREATE TABLE "brain_policies" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"status" "knowledge_status" DEFAULT 'requires_review' NOT NULL,
	"source" text,
	"source_url" text,
	"reviewed_at" timestamp with time zone,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"confidence" numeric(3, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cctv_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"packet" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"markup_override" numeric(5, 2),
	"actor" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'email' NOT NULL,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"thread_id" uuid,
	"assessment_id" uuid,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_by_actor" text NOT NULL,
	"created_by_id" uuid,
	"review_note" text,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_hash" text,
	"mailbox_draft_message_id" text,
	"sent_email_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"property_type" text DEFAULT 'residential' NOT NULL,
	"min_cameras" integer NOT NULL,
	"max_cameras" integer NOT NULL,
	"storeys" integer,
	"estimated_hours" numeric(6, 2) NOT NULL,
	"allowance_ex_gst" numeric(12, 2) NOT NULL,
	"included_materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "knowledge_status" DEFAULT 'requires_review' NOT NULL,
	"source" text,
	"source_url" text,
	"reviewed_at" timestamp with time zone,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"confidence" numeric(3, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"old_cost_ex_gst" numeric(12, 2),
	"new_cost_ex_gst" numeric(12, 2) NOT NULL,
	"changed_pct" numeric(8, 2),
	"source" text NOT NULL,
	"review_status" text DEFAULT 'not_reviewed' NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturer" text NOT NULL,
	"model" text NOT NULL,
	"category" text NOT NULL,
	"market" text DEFAULT 'both' NOT NULL,
	"tier" text,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warranty" text,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "knowledge_status" DEFAULT 'requires_review' NOT NULL,
	"source" text,
	"source_url" text,
	"reviewed_at" timestamp with time zone,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"confidence" numeric(3, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_credentials" (
	"supplier_id" uuid PRIMARY KEY NOT NULL,
	"username" text,
	"secret_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_sku" text,
	"cost_ex_gst" numeric(12, 2),
	"cost_inc_gst" numeric(12, 2),
	"price_approved" boolean DEFAULT false NOT NULL,
	"pending_cost_ex_gst" numeric(12, 2),
	"stock" text,
	"source_url" text,
	"last_checked_at" timestamp with time zone,
	"price_confidence" numeric(3, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"account_status" text,
	"price_source_type" text DEFAULT 'manual' NOT NULL,
	"integration_method" text,
	"last_price_sync_at" timestamp with time zone,
	"priority" integer DEFAULT 100 NOT NULL,
	"brands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "knowledge_status" DEFAULT 'requires_review' NOT NULL,
	"source" text,
	"source_url" text,
	"reviewed_at" timestamp with time zone,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"confidence" numeric(3, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "assessment_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "revision_of_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "approved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "approval_hash" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "internal_costing" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "confidence" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_policies" ADD CONSTRAINT "brain_policies_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cctv_assessments" ADD CONSTRAINT "cctv_assessments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cctv_assessments" ADD CONSTRAINT "cctv_assessments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_assessment_id_cctv_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."cctv_assessments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_sent_email_id_emails_id_fk" FOREIGN KEY ("sent_email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD CONSTRAINT "installation_packages_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credentials" ADD CONSTRAINT "supplier_credentials_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cctv_assessments_lead_idx" ON "cctv_assessments" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "drafts_status_idx" ON "drafts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "drafts_lead_idx" ON "drafts" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "price_history_offer_idx" ON "product_price_history" USING btree ("supplier_product_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_model_idx" ON "products" USING btree ("manufacturer","model");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_products_idx" ON "supplier_products" USING btree ("product_id","supplier_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing admins (Chris) approve customer-facing actions; others can be given it in Staff.
UPDATE "users" SET "can_approve" = true WHERE "role" = 'admin';--> statement-breakpoint
-- Supplier priority from the Business Brain brief. Names 2 and 3 still to be verified.
INSERT INTO "suppliers" ("name", "priority", "price_source_type", "status", "source", "notes") VALUES
  ('IT Plus', 1, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.1 (Chris)', 'Priority 1 supplier.'),
  ('Play Digital', 2, 'manual', 'requires_review', 'Get Secure CCTV Business Brain v0.1 (Chris)', 'Verify exact supplier identity/name.'),
  ('Dicker Data', 3, 'manual', 'requires_review', 'Get Secure CCTV Business Brain v0.1 (Chris)', 'Verify exact account/entity name (Dicker Data / Dicker Data Connect).')
ON CONFLICT ("name") DO NOTHING;
