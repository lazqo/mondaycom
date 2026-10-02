CREATE TABLE "materials_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"property_type" text DEFAULT 'residential' NOT NULL,
	"customer_description" text DEFAULT 'Cabling and standard installation materials' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_ex_gst" numeric(12, 2),
	"sell_ex_gst" numeric(12, 2),
	"is_default" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "product_compatibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"from_product_id" uuid NOT NULL,
	"to_product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
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
CREATE TABLE "supplier_brand_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"rank" integer DEFAULT 1 NOT NULL,
	"market" text DEFAULT 'both' NOT NULL,
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
ALTER TABLE "installation_packages" ALTER COLUMN "estimated_hours" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_packages" ALTER COLUMN "allowance_ex_gst" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "labour_rate" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "materials_package_id" uuid;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "conduit_included" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "conduit_allowance_ex_gst" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "family" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "form_factor" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "residential_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "commercial_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tier_status" "knowledge_status" DEFAULT 'requires_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "ecosystem" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unverified_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "price_on_application" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "price_source" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "materials_packages" ADD CONSTRAINT "materials_packages_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_compatibility" ADD CONSTRAINT "product_compatibility_from_product_id_products_id_fk" FOREIGN KEY ("from_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_compatibility" ADD CONSTRAINT "product_compatibility_to_product_id_products_id_fk" FOREIGN KEY ("to_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_compatibility" ADD CONSTRAINT "product_compatibility_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_brand_routes" ADD CONSTRAINT "supplier_brand_routes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_brand_routes" ADD CONSTRAINT "supplier_brand_routes_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_compatibility_idx" ON "product_compatibility" USING btree ("kind","from_product_id","to_product_id");--> statement-breakpoint
CREATE INDEX "product_compatibility_to_idx" ON "product_compatibility" USING btree ("to_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_brand_routes_idx" ON "supplier_brand_routes" USING btree ("brand","supplier_id","market");--> statement-breakpoint
ALTER TABLE "installation_packages" ADD CONSTRAINT "installation_packages_materials_package_id_materials_packages_id_fk" FOREIGN KEY ("materials_package_id") REFERENCES "public"."materials_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Business Brain v0.2 reference data (from the v0.2 brief). Everything here is editable in
-- Settings → Business Brain; nothing is priced.
UPDATE "products" SET "residential_allowed" = ("market" <> 'commercial'), "commercial_allowed" = ("market" <> 'residential'), "family" = COALESCE("family", "manufacturer");
--> statement-breakpoint
UPDATE "suppliers" SET "is_default" = true, "priority" = 1, "status" = 'getsecure_approved', "notes" = 'Primary/default supplier (Business Brain v0.2 brief).' WHERE "name" = 'IT Plus';
--> statement-breakpoint
INSERT INTO "suppliers" ("name", "priority", "price_source_type", "status", "source", "brands", "notes") VALUES
  ('Clear Digital', 2, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '["Dahua","Ajax","Uniview","Gallagher","Aiphone"]', NULL),
  ('SWL / Security Wholesale', 3, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '["Provision-ISR"]', NULL),
  ('Atlas Gentech', 4, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '["Axis","Hanwha","Inner Range","Hikvision"]', 'Hikvision: commercial alternative where appropriate.'),
  ('IOT Technologies', 5, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '["Tiandy","Dahua","Ajax","Uniview","Akuvox"]', NULL),
  ('Vesta Electrical', 6, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]', 'No brand routes yet.')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
UPDATE "suppliers" SET "brands" = '["TP-Link VIGI","HiLook","Hikvision","TVT","Uniview","AAP","Akuvox"]' WHERE "name" = 'IT Plus';
--> statement-breakpoint
-- Suppliers from the v0.1 brief that are not in the v0.2 list: kept for history, not used, unless they already hold prices.
UPDATE "suppliers" SET "status" = 'deprecated', "notes" = 'Not in the Get Secure supplier list (Business Brain v0.2 brief). Re-enable in Settings if needed.'
WHERE "name" IN ('Play Digital', 'Dicker Data') AND NOT EXISTS (SELECT 1 FROM "supplier_products" sp WHERE sp."supplier_id" = "suppliers"."id");
--> statement-breakpoint
INSERT INTO "supplier_brand_routes" ("brand", "supplier_id", "rank", "market", "status", "source", "notes")
SELECT r.brand, s.id, r.rank, r.market, 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', r.notes
FROM (VALUES
  ('TP-Link VIGI', 'IT Plus', 1, 'both', NULL),
  ('HiLook', 'IT Plus', 1, 'both', NULL),
  ('Hikvision', 'IT Plus', 1, 'both', 'Preferred for normal/residential.'),
  ('Hikvision', 'Atlas Gentech', 2, 'commercial', 'Alternative for commercial where appropriate.'),
  ('TVT', 'IT Plus', 1, 'both', NULL),
  ('Tiandy', 'IOT Technologies', 1, 'both', NULL),
  ('Dahua', 'Clear Digital', 1, 'both', NULL),
  ('Dahua', 'IOT Technologies', 2, 'both', NULL),
  ('Ajax', 'Clear Digital', 1, 'both', NULL),
  ('Ajax', 'IOT Technologies', 2, 'both', NULL),
  ('Uniview', 'IT Plus', 1, 'both', NULL),
  ('Uniview', 'Clear Digital', 2, 'both', NULL),
  ('Uniview', 'IOT Technologies', 3, 'both', NULL),
  ('Axis', 'Atlas Gentech', 1, 'both', NULL),
  ('Hanwha', 'Atlas Gentech', 1, 'both', NULL),
  ('Inner Range', 'Atlas Gentech', 1, 'both', NULL),
  ('AAP', 'IT Plus', 1, 'both', NULL),
  ('Akuvox', 'IT Plus', 1, 'both', NULL),
  ('Akuvox', 'IOT Technologies', 2, 'both', NULL),
  ('Gallagher', 'Clear Digital', 1, 'both', NULL),
  ('Aiphone', 'Clear Digital', 1, 'both', NULL),
  ('Provision-ISR', 'SWL / Security Wholesale', 1, 'both', NULL)
) AS r(brand, supplier, rank, market, notes)
JOIN "suppliers" s ON s."name" = r.supplier
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "materials_packages" ("name", "property_type", "customer_description", "items", "cost_ex_gst", "sell_ex_gst", "is_default", "status", "source", "notes")
VALUES (
  'Standard residential CCTV materials', 'residential', 'Cabling and standard installation materials',
  '[{"description":"Normal Cat6 allowance","quantity":null,"costExGst":null},{"description":"Connectors","quantity":null,"costExGst":null},{"description":"Normal clips and fixings","quantity":null,"costExGst":null},{"description":"Weatherproofing and entry consumables","quantity":null,"costExGst":null},{"description":"Miscellaneous CCTV installation materials","quantity":null,"costExGst":null}]',
  (SELECT ("value"->>'costExGst')::numeric FROM "brain_policies" WHERE "key" = 'standardMaterials'),
  (SELECT ("value"->>'sellExGst')::numeric FROM "brain_policies" WHERE "key" = 'standardMaterials'),
  true, 'requires_review', 'Get Secure CCTV Business Brain v0.2 (Chris): contents', 'Internal cost and charged value to be set by Get Secure.'
);
--> statement-breakpoint
DELETE FROM "brain_policies" WHERE "key" = 'standardMaterials';
--> statement-breakpoint
INSERT INTO "installation_packages" ("name", "property_type", "min_cameras", "max_cameras", "storeys", "estimated_hours", "labour_rate", "allowance_ex_gst", "materials_package_id", "conduit_included", "conduit_allowance_ex_gst", "included_materials", "assumptions", "exclusions", "status", "source", "notes")
SELECT p.name, 'residential', p.min, p.max, p.storeys, NULL, 95, NULL, (SELECT "id" FROM "materials_packages" WHERE "is_default" ORDER BY "created_at" LIMIT 1), p.storeys = 2, NULL,
  '["Cabling and standard installation materials"]',
  CASE WHEN p.storeys = 2
    THEN '["Additional installation complexity for upper-storey cameras","Conduit allowance considered for exposed upper-storey runs","Cable routes to be confirmed (site/cable-route assumption)"]'::jsonb
    ELSE '["Standard residential construction with accessible cable routes"]'::jsonb END,
  '["Monitor/TV unless listed","Electrical work beyond standard installation","Internet connection and data costs"]',
  'requires_review', 'Get Secure CCTV Business Brain v0.2 (Chris): package structure', 'Hours and package price to be entered and approved by Get Secure.'
FROM (VALUES
  ('Residential 1–2 cameras, single storey', 1, 2, 1),
  ('Residential 3–4 cameras, single storey', 3, 4, 1),
  ('Residential 5–6 cameras, single storey', 5, 6, 1),
  ('Residential 7–8 cameras, single storey', 7, 8, 1),
  ('Residential 1–2 cameras, double storey', 1, 2, 2),
  ('Residential 3–4 cameras, double storey', 3, 4, 2),
  ('Residential 5–6 cameras, double storey', 5, 6, 2),
  ('Residential 7–8 cameras, double storey', 7, 8, 2)
) AS p(name, min, max, storeys);
--> statement-breakpoint
-- Tier policy from the v0.2 brief, unless it has already been edited in the CRM.
UPDATE "brain_policies" SET
  "value" = '{"good":{"targetMp":4,"brands":["TP-Link VIGI"],"description":"Lower-cost/value products, commonly around 4-5MP. VIGI evaluated first."},"better":{"targetMp":6,"brands":["HiLook","Tiandy","Dahua"],"description":"Stronger image/features, commonly around 6MP, depending on the actual product and cost."},"best":{"targetMp":8,"brands":["Hikvision"],"description":"Higher-end residential image/features, commonly 8MP. Hikvision is a primary candidate."},"premium":{"targetMp":null,"brands":["Ajax"],"description":"Ecosystem-specific: Ajax Video where the integrated Ajax ecosystem is the reason for choosing it.","ecosystemOnly":true}}',
  "status" = 'getsecure_approved', "source" = 'Get Secure CCTV Business Brain v0.2 (Chris)', "notes" = 'Starting policy. Tiers are commercial/value positions, not megapixel rules; the tier is set per product.', "updated_at" = now()
WHERE "key" = 'tiers' AND ("source" IS NULL OR "source" = 'Get Secure CCTV Business Brain v0.1 (Chris)');
