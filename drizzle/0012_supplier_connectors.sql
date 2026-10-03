CREATE TABLE "supplier_connectors" (
	"supplier_id" uuid PRIMARY KEY NOT NULL,
	"connector" text NOT NULL,
	"status" text DEFAULT 'not_tested' NOT NULL,
	"status_detail" text,
	"last_login_ok_at" timestamp with time zone,
	"last_login_failed_at" timestamp with time zone,
	"last_login_failure" text,
	"last_login_failure_code" text,
	"last_sync_ok_at" timestamp with time zone,
	"last_sync_failed_at" timestamp with time zone,
	"last_sync_failure" text,
	"price_basis_seen" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_by_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_price_history" ADD COLUMN "price_source" text;--> statement-breakpoint
ALTER TABLE "product_price_history" ADD COLUMN "stock" text;--> statement-breakpoint
ALTER TABLE "product_price_history" ADD COLUMN "sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_connectors" ADD CONSTRAINT "supplier_connectors_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD CONSTRAINT "supplier_sync_runs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD CONSTRAINT "supplier_sync_runs_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_sync_runs_idx" ON "supplier_sync_runs" USING btree ("supplier_id","started_at");--> statement-breakpoint
-- IT Plus trade prices now arrive through its authenticated web catalogue (the stored, encrypted
-- trade login). Only the source type and connector registration change; no prices are touched.
UPDATE "suppliers" SET "price_source_type" = 'authenticated_web', "integration_method" = 'IT Plus trade login (www.itplus.co.nz, WooCommerce)', "website" = COALESCE("website", 'https://www.itplus.co.nz') WHERE "name" = 'IT Plus';--> statement-breakpoint
INSERT INTO "supplier_connectors" ("supplier_id", "connector") SELECT "id", 'itplus' FROM "suppliers" WHERE "name" = 'IT Plus' ON CONFLICT DO NOTHING;
