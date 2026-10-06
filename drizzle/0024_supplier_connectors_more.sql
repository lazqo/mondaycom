-- Trade-login connectors for Clear Digital, SWL / Security Wholesale and Vesta Electrical (the
-- same runner as IT Plus; one site module each). Only the source type, the website and the
-- connector registration change; no prices are touched, and no login is stored here.
UPDATE "suppliers" SET "price_source_type" = 'authenticated_web', "integration_method" = 'Clear Digital trade login (www.cleardigital.co.nz)', "website" = COALESCE("website", 'https://www.cleardigital.co.nz') WHERE "name" = 'Clear Digital';--> statement-breakpoint
UPDATE "suppliers" SET "price_source_type" = 'authenticated_web', "integration_method" = 'SWL trade login (www.swl.co.nz, WebNinja)', "website" = COALESCE("website", 'https://www.swl.co.nz') WHERE "name" = 'SWL / Security Wholesale';--> statement-breakpoint
UPDATE "suppliers" SET "price_source_type" = 'authenticated_web', "integration_method" = 'Vesta Electrical trade login (www.vestaelectrical.co.nz, WebNinja)', "website" = COALESCE("website", 'https://www.vestaelectrical.co.nz') WHERE "name" = 'Vesta Electrical';--> statement-breakpoint
INSERT INTO "supplier_connectors" ("supplier_id", "connector") SELECT "id", 'cleardigital' FROM "suppliers" WHERE "name" = 'Clear Digital' ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "supplier_connectors" ("supplier_id", "connector") SELECT "id", 'swl' FROM "suppliers" WHERE "name" = 'SWL / Security Wholesale' ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "supplier_connectors" ("supplier_id", "connector") SELECT "id", 'vesta' FROM "suppliers" WHERE "name" = 'Vesta Electrical' ON CONFLICT DO NOTHING;
