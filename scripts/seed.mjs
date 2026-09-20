// Creates the first admin user (if none exists) and, with --sample, a few example leads.
// Plain JS + SQL so it runs in the production image: `node scripts/seed.mjs [--sample]`.
import { existsSync } from "node:fs";
import postgres from "postgres";
import bcrypt from "bcryptjs";

if (existsSync(".env")) {
  const { config } = await import("dotenv");
  config();
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const withSample = process.argv.includes("--sample");
const sql = postgres(url, { max: 1, onnotice: () => {}, ssl: /sslmode=require/.test(url) ? "require" : undefined });

try {
  const [{ count }] = await sql`select count(*)::int as count from users`;
  let adminId;
  if (count === 0) {
    const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!password) throw new Error("SEED_ADMIN_PASSWORD is required to create the first admin user");
    const name = process.env.SEED_ADMIN_NAME ?? "Admin";
    const hash = await bcrypt.hash(password, 10);
    const [row] = await sql`
      insert into users (email, name, password_hash, role)
      values (${email}, ${name}, ${hash}, 'admin') returning id`;
    adminId = row.id;
    console.log(`Created admin user ${email}`);
  } else {
    const [row] = await sql`select id from users order by created_at asc limit 1`;
    adminId = row.id;
    console.log(`Users already exist (${count}); skipping admin creation.`);
  }

  if (withSample) {
    const [{ count: leadCount }] = await sql`select count(*)::int as count from leads`;
    if (leadCount > 0) {
      console.log(`Leads already exist (${leadCount}); skipping sample data.`);
    } else {
      const plus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      const rows = [
        { name: "Sarah Mitchell", company: "Harbourview Apartments", phone: "021 555 0142", email: "sarah@harbourview.co.nz", service: "CCTV install", site: "12 Quay St, Auckland", status: "new", source: "email", follow_up_at: plus(1), last_contact_at: null, assigned_to_id: adminId, position: 0 },
        { name: "Tom Ngata", company: "Ngata Builders", phone: "027 555 0199", email: "tom@ngatabuilders.co.nz", service: "Alarm monitoring", site: "45 Great South Rd, Penrose", status: "contacted", source: "phone", follow_up_at: plus(3), last_contact_at: plus(-2), assigned_to_id: adminId, position: 1 },
        { name: "Priya Desai", company: null, phone: "022 555 0107", email: "priya.d@gmail.com", service: "Access control", site: "8 Wharf Rd, Devonport", status: "site_visit", source: "website", follow_up_at: plus(2), last_contact_at: plus(-1), assigned_to_id: null, position: 2 },
        { name: "Mike O'Connor", company: "Westgate Retail Ltd", phone: "09 555 0123", email: "mike@westgateretail.co.nz", service: "CCTV + alarm", site: "Unit 4, Westgate Mall", status: "quote_required", source: "referral", follow_up_at: plus(0), last_contact_at: plus(-3), assigned_to_id: adminId, position: 3 },
      ].map((r) => ({ ...r, created_by_id: adminId }));
      await sql`insert into leads ${sql(rows)}`;
      console.log("Inserted sample leads.");
    }
  }
} finally {
  await sql.end();
}
