"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { requireAdmin, requireOffice as requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { connectionFromMailbox, syncMailboxOnce, testImapConnection, type MailboxConnection } from "@/lib/email/imap";
import { testSmtpConnection } from "@/lib/email/smtp";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const mailboxInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  emailAddress: z.string().trim().toLowerCase().email("Invalid email address"),
  imapHost: z.string().trim().min(1, "IMAP host is required"),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  imapSecure: z.coerce.boolean().default(true),
  smtpHost: z.string().trim().min(1, "SMTP host is required"),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
  smtpSecure: z.coerce.boolean().default(true),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().optional(),
  folder: z.string().trim().min(1).default("INBOX"),
  active: z.coerce.boolean().default(true),
  syncSent: z.coerce.boolean().default(true),
});
export type MailboxInput = z.input<typeof mailboxInput>;

function formToObject(fd: FormData) {
  const o = Object.fromEntries(fd) as Record<string, unknown>;
  for (const k of ["imapSecure", "smtpSecure", "active", "syncSent"]) o[k] = o[k] === "on" || o[k] === "true";
  return o;
}

export async function createMailbox(formData: FormData): Promise<ActionResult<{ id: string }>> {
  await requireAdmin();
  const parsed = mailboxInput.safeParse(formToObject(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  if (!d.password) return fail("Password (or app password) is required");
  const [row] = await db
    .insert(mailboxes)
    .values({ ...d, passwordEncrypted: encryptSecret(d.password) })
    .returning({ id: mailboxes.id });
  revalidatePath("/settings/mailboxes");
  return ok({ id: row.id });
}

export async function updateMailbox(id: string, formData: FormData): Promise<ActionResult<undefined>> {
  await requireAdmin();
  const parsed = mailboxInput.safeParse(formToObject(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const { password, ...rest } = parsed.data;
  await db
    .update(mailboxes)
    .set({ ...rest, ...(password ? { passwordEncrypted: encryptSecret(password) } : {}), updatedAt: new Date() })
    .where(eq(mailboxes.id, id));
  revalidatePath("/settings/mailboxes");
  return ok(undefined);
}

export async function deleteMailbox(id: string): Promise<ActionResult<undefined>> {
  await requireAdmin();
  await db.delete(mailboxes).where(eq(mailboxes.id, id));
  revalidatePath("/settings/mailboxes");
  revalidatePath("/inbox");
  return ok(undefined);
}

/** Test IMAP + SMTP credentials. Uses the stored password when the form leaves it blank. */
export async function testMailbox(id: string | null, formData: FormData): Promise<ActionResult<{ imap: string; smtp: string }>> {
  await requireAdmin();
  const parsed = mailboxInput.safeParse(formToObject(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  let conn: MailboxConnection;
  if (parsed.data.password) {
    conn = { ...parsed.data, password: parsed.data.password };
  } else if (id) {
    const m = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, id) });
    if (!m) return fail("Mailbox not found");
    conn = { ...connectionFromMailbox(m), ...parsed.data, password: connectionFromMailbox(m).password };
  } else {
    return fail("Enter the password to test the connection");
  }
  let imap: string;
  try {
    const r = await testImapConnection(conn);
    imap = `OK — ${r.folder} has ${r.messages} messages`;
  } catch (err) {
    imap = `Failed — ${err instanceof Error ? err.message : String(err)}`;
  }
  let smtp: string;
  try {
    await testSmtpConnection(conn);
    smtp = "OK";
  } catch (err) {
    smtp = `Failed — ${err instanceof Error ? err.message : String(err)}`;
  }
  return ok({ imap, smtp });
}

export async function syncMailboxNow(id: string): Promise<ActionResult<{ fetched: number; stored: number; sent: number; leads: number; review: number }>> {
  await requireUser();
  try {
    const s = await syncMailboxOnce(id);
    revalidatePath("/inbox");
    revalidatePath("/leads");
    revalidatePath("/settings/mailboxes");
    return ok({
      fetched: s.fetched,
      stored: s.stored,
      sent: s.sentStored ?? 0,
      leads: s.outcomes.filter((o) => o.classification === "lead").length,
      review: s.outcomes.filter((o) => o.classification === "needs_review").length,
    });
  } catch (err) {
    revalidatePath("/settings/mailboxes");
    return fail(err instanceof Error ? err.message : String(err));
  }
}
