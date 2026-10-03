ALTER TABLE "installation_packages" ADD COLUMN "install_type" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
-- CCTV upgrade packages: reusing existing Cat5e/Cat6 runs and camera positions. Structure only:
-- labour hours, materials, allowances and the customer sell allowance are Get Secure's to enter and
-- approve, so they stay empty and the packages need Chris's approval.
INSERT INTO "installation_packages" ("key", "name", "property_type", "install_type", "camera_count", "storey_type", "min_cameras", "max_cameras", "storeys", "labour_rate", "conduit_included", "included_materials", "assumptions", "exclusions", "status", "source", "notes") VALUES
  ('RES_CCTV_UPGRADE_IP_2', 'Residential CCTV IP upgrade (existing Cat5e/Cat6 reused), 2 cameras', 'residential', 'upgrade_ip', 2, NULL, 2, 2, NULL, 95, false, '["Re-termination and testing of existing runs"]', '["Existing Cat5e/Cat6 runs are reused, subject to testing and re-termination","Cameras go in the existing camera positions"]', '["Replacing existing cable runs that fail testing (quoted separately)"]', 'requires_review', 'Get Secure CCTV Business Brain v1 (Chris): upgrade package structure', 'Values to be set and approved by Get Secure.'),
  ('RES_CCTV_UPGRADE_IP_4', 'Residential CCTV IP upgrade (existing Cat5e/Cat6 reused), 4 cameras', 'residential', 'upgrade_ip', 4, NULL, 4, 4, NULL, 95, false, '["Re-termination and testing of existing runs"]', '["Existing Cat5e/Cat6 runs are reused, subject to testing and re-termination","Cameras go in the existing camera positions"]', '["Replacing existing cable runs that fail testing (quoted separately)"]', 'requires_review', 'Get Secure CCTV Business Brain v1 (Chris): upgrade package structure', 'Values to be set and approved by Get Secure.'),
  ('RES_CCTV_UPGRADE_IP_6', 'Residential CCTV IP upgrade (existing Cat5e/Cat6 reused), 6 cameras', 'residential', 'upgrade_ip', 6, NULL, 6, 6, NULL, 95, false, '["Re-termination and testing of existing runs"]', '["Existing Cat5e/Cat6 runs are reused, subject to testing and re-termination","Cameras go in the existing camera positions"]', '["Replacing existing cable runs that fail testing (quoted separately)"]', 'requires_review', 'Get Secure CCTV Business Brain v1 (Chris): upgrade package structure', 'Values to be set and approved by Get Secure.'),
  ('RES_CCTV_UPGRADE_IP_8', 'Residential CCTV IP upgrade (existing Cat5e/Cat6 reused), 8 cameras', 'residential', 'upgrade_ip', 8, NULL, 8, 8, NULL, 95, false, '["Re-termination and testing of existing runs"]', '["Existing Cat5e/Cat6 runs are reused, subject to testing and re-termination","Cameras go in the existing camera positions"]', '["Replacing existing cable runs that fail testing (quoted separately)"]', 'requires_review', 'Get Secure CCTV Business Brain v1 (Chris): upgrade package structure', 'Values to be set and approved by Get Secure.')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Residential Standard: the values Chris agreed (H.265+, VBR, 25 fps, design bitrate per resolution).
-- Filled in only where nothing has been entered yet (no rules), never over values already in the CRM,
-- and left for Chris to approve in Settings → Business Brain → Recording profiles.
UPDATE "recording_profiles" SET
  "codec" = COALESCE("codec", 'H.265+'),
  "bitrate_control" = COALESCE("bitrate_control", 'VBR'),
  "frame_rate" = COALESCE("frame_rate", 25),
  "rules" = '[{"id":"res-2mp","scope":"resolution","minMp":1.6,"maxMp":2.4,"designBitrateMbps":1.5,"note":"2MP"},{"id":"res-3mp","scope":"resolution","minMp":2.6,"maxMp":3.4,"designBitrateMbps":2.0,"note":"3MP"},{"id":"res-4mp","scope":"resolution","minMp":3.6,"maxMp":4.4,"designBitrateMbps":2.5,"note":"4MP"},{"id":"res-5mp","scope":"resolution","minMp":4.6,"maxMp":5.4,"designBitrateMbps":3.0,"note":"5MP"},{"id":"res-6mp","scope":"resolution","minMp":5.6,"maxMp":6.4,"designBitrateMbps":3.5,"note":"6MP"},{"id":"res-8mp","scope":"resolution","minMp":7.6,"maxMp":8.4,"designBitrateMbps":4.5,"note":"8MP"},{"id":"res-12mp","scope":"resolution","minMp":11.6,"maxMp":12.4,"designBitrateMbps":6.5,"note":"12MP"}]'::jsonb,
  "status" = CASE WHEN "status" = 'requires_review' THEN 'getsecure_provisional'::knowledge_status ELSE "status" END,
  "notes" = 'Values agreed by Chris (H.265+, VBR, 25 fps; 2MP 1.5, 3MP 2.0, 4MP 2.5, 5MP 3.0, 6MP 3.5, 8MP 4.5, 12MP 6.5 Mbps). Approve here before quoting. 24/7 continuous, 28-day target and 14-day minimum are approved Get Secure policy.',
  "updated_at" = now()
WHERE "key" = 'RES_STANDARD' AND "rules" = '[]'::jsonb;
