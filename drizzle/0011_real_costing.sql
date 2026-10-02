CREATE TABLE "recording_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"property_type" text DEFAULT 'residential' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"codec" text,
	"frame_rate" integer,
	"bitrate_control" text,
	"recording_mode" text,
	"retention_target_days" integer,
	"retention_minimum_days" integer,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
	CONSTRAINT "recording_profiles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "camera_count" integer;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "storey_type" text;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "material_cost_ex_gst" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "installation_packages" ADD COLUMN "complexity_allowance_ex_gst" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "price_basis" text DEFAULT 'trade' NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_profiles" ADD CONSTRAINT "recording_profiles_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_packages" ADD CONSTRAINT "installation_packages_key_unique" UNIQUE("key");--> statement-breakpoint
-- v0.3: residential packages are keyed by an exact camera count. The v0.2 range packages are removed
-- if nobody has entered anything in them, otherwise kept and deprecated (they no longer match jobs).
DELETE FROM "installation_packages"
WHERE "source" = 'Get Secure CCTV Business Brain v0.2 (Chris): package structure'
  AND "estimated_hours" IS NULL AND "allowance_ex_gst" IS NULL AND "conduit_allowance_ex_gst" IS NULL AND "approved_at" IS NULL;
--> statement-breakpoint
UPDATE "installation_packages" SET "status" = 'deprecated', "notes" = COALESCE("notes" || ' ', '') || 'Range package from v0.2; replaced by exact-count packages in v0.3.', "updated_at" = now()
WHERE "source" = 'Get Secure CCTV Business Brain v0.2 (Chris): package structure';
--> statement-breakpoint
INSERT INTO "installation_packages" ("key", "name", "property_type", "camera_count", "storey_type", "min_cameras", "max_cameras", "storeys", "estimated_hours", "labour_rate", "allowance_ex_gst", "material_cost_ex_gst", "materials_package_id", "conduit_included", "conduit_allowance_ex_gst", "complexity_allowance_ex_gst", "included_materials", "assumptions", "exclusions", "status", "source", "notes")
SELECT p.key, p.name, 'residential', p.n, p.st, p.n, p.n, CASE WHEN p.st = 'double' THEN 2 ELSE 1 END, NULL, 95, NULL, NULL,
  (SELECT "id" FROM "materials_packages" WHERE "is_default" ORDER BY "created_at" LIMIT 1), p.st = 'double', NULL, NULL,
  '["Cabling and standard installation materials"]',
  CASE WHEN p.st = 'double'
    THEN '["Additional installation complexity for upper-storey cameras","Conduit allowance considered for exposed upper-storey runs","Cable routes to be confirmed (site/cable-route assumption)"]'::jsonb
    ELSE '["Standard residential construction with accessible cable routes"]'::jsonb END,
  '["Monitor/TV unless listed","Electrical work beyond standard installation","Internet connection and data costs"]',
  'requires_review', 'Get Secure CCTV Business Brain v0.3 (Chris): package structure',
  'Labour hours, standard material cost, conduit/complexity allowances and customer sell allowance to be entered and approved by Get Secure.'
FROM (VALUES
  ('RES_CCTV_SINGLE_2', 'Residential CCTV, single storey, 2 cameras', 2, 'single'),
  ('RES_CCTV_SINGLE_4', 'Residential CCTV, single storey, 4 cameras', 4, 'single'),
  ('RES_CCTV_SINGLE_6', 'Residential CCTV, single storey, 6 cameras', 6, 'single'),
  ('RES_CCTV_SINGLE_8', 'Residential CCTV, single storey, 8 cameras', 8, 'single'),
  ('RES_CCTV_DOUBLE_2', 'Residential CCTV, double storey, 2 cameras', 2, 'double'),
  ('RES_CCTV_DOUBLE_4', 'Residential CCTV, double storey, 4 cameras', 4, 'double'),
  ('RES_CCTV_DOUBLE_6', 'Residential CCTV, double storey, 6 cameras', 6, 'double'),
  ('RES_CCTV_DOUBLE_8', 'Residential CCTV, double storey, 8 cameras', 8, 'double')
) AS p(key, name, n, st)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "recording_profiles" ("key", "name", "property_type", "is_default", "codec", "frame_rate", "bitrate_control", "recording_mode", "retention_target_days", "retention_minimum_days", "rules", "status", "source", "notes") VALUES
  ('RES_STANDARD', 'Residential standard', 'residential', true, NULL, NULL, NULL, 'continuous', 28, 14, '[]', 'requires_review', 'Get Secure CCTV Business Brain v0.3 (Chris)',
   '24/7 continuous, 28-day target and 14-day minimum are approved Get Secure policy. Codec, frame rate and design bitrates are to be set and approved.'),
  ('RES_HIGH_DETAIL', 'Residential high-detail', 'residential', false, NULL, NULL, NULL, 'continuous', 28, 14, '[]', 'requires_review', 'Get Secure CCTV Business Brain v0.3 (Chris)',
   'Higher-detail residential configuration. Codec, frame rate and design bitrates are to be set and approved.'),
  ('COM_STANDARD', 'Commercial standard', 'commercial', true, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 'requires_review', 'Get Secure CCTV Business Brain v0.3 (Chris)',
   'All values to be set and approved; commercial systems are confirmed at the site visit.'),
  ('CUSTOM', 'Custom', 'any', false, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 'requires_review', 'Get Secure CCTV Business Brain v0.3 (Chris)',
   'For a job-specific configuration.')
ON CONFLICT ("key") DO NOTHING;
