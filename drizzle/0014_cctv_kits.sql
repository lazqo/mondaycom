CREATE TABLE "cctv_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"property_type" text DEFAULT 'residential' NOT NULL,
	"tier" text,
	"camera_count" integer NOT NULL,
	"camera_product_id" uuid NOT NULL,
	"nvr_product_id" uuid NOT NULL,
	"default_hdd_tb" numeric(6, 2),
	"default_hdd_product_id" uuid,
	"accessories" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cctv_kits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "cctv_kits" ADD CONSTRAINT "cctv_kits_camera_product_id_products_id_fk" FOREIGN KEY ("camera_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cctv_kits" ADD CONSTRAINT "cctv_kits_nvr_product_id_products_id_fk" FOREIGN KEY ("nvr_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cctv_kits" ADD CONSTRAINT "cctv_kits_default_hdd_product_id_products_id_fk" FOREIGN KEY ("default_hdd_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cctv_kits" ADD CONSTRAINT "cctv_kits_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;