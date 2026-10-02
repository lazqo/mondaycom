-- The current Get Secure supplier list (Business Brain v0.2 brief): these six are active.
-- Play Digital and Dicker Data were provisional v0.1 information: kept as historical records,
-- deprecated, never quoted from (deprecated suppliers' listings are ignored when pricing).
INSERT INTO "suppliers" ("name", "priority", "price_source_type", "status", "source", "brands") VALUES
  ('IT Plus', 1, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]'),
  ('Clear Digital', 2, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]'),
  ('SWL / Security Wholesale', 3, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]'),
  ('Atlas Gentech', 4, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]'),
  ('IOT Technologies', 5, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]'),
  ('Vesta Electrical', 6, 'manual', 'getsecure_approved', 'Get Secure CCTV Business Brain v0.2 (Chris)', '[]')
ON CONFLICT ("name") DO UPDATE SET "status" = 'getsecure_approved', "updated_at" = now()
  WHERE "suppliers"."status" IN ('requires_review', 'deprecated', 'getsecure_provisional');
--> statement-breakpoint
UPDATE "suppliers" SET "is_default" = ("name" = 'IT Plus');
--> statement-breakpoint
UPDATE "suppliers" SET "status" = 'deprecated', "is_default" = false, "priority" = 900,
  "notes" = 'Older/provisional supplier from the v0.1 brief; not in the current Get Secure supplier list. Kept as a historical record and never used for quoting.',
  "updated_at" = now()
WHERE "name" IN ('Play Digital', 'Dicker Data');
--> statement-breakpoint
-- Starting brand preferences (editable in Settings → Business Brain → Suppliers & routing).
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
