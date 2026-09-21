import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

export type ParsedAddress = { name: string | null; address: string };
export type ParsedEmail = {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  date: Date;
  text: string;
  html: string | null;
  headers: Record<string, string>;
  attachments: { filename: string; contentType: string; size: number; contentId: string | null; content: Buffer }[];
};

function addrs(a: AddressObject | AddressObject[] | undefined): ParsedAddress[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((o) =>
    o.value
      .filter((v) => v.address)
      .map((v) => ({ name: v.name?.trim() || null, address: v.address!.toLowerCase() })),
  );
}

/** Convert HTML to readable plain text when the message has no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseRawEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const mail: ParsedMail = await simpleParser(raw, { skipImageLinks: true });
  const from = addrs(mail.from)[0] ?? { name: null, address: "" };
  const html = typeof mail.html === "string" ? mail.html : null;
  const text = (mail.text ?? "").trim() || (html ? htmlToText(html) : "");
  const headers: Record<string, string> = {};
  for (const [k, v] of mail.headers) {
    if (typeof v === "string") headers[k] = v;
    else if (v && typeof v === "object" && "text" in v && typeof (v as { text?: unknown }).text === "string") headers[k] = (v as { text: string }).text;
  }
  const references = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
  return {
    messageId: mail.messageId ?? `<generated-${Date.now()}-${Math.random().toString(36).slice(2)}@get-secure-crm>`,
    inReplyTo: mail.inReplyTo ?? null,
    references,
    from,
    to: addrs(mail.to),
    cc: addrs(mail.cc),
    subject: (mail.subject ?? "").trim(),
    date: mail.date ?? new Date(),
    text,
    html,
    headers,
    attachments: (mail.attachments ?? []).map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType ?? "application/octet-stream",
      size: a.size ?? a.content?.length ?? 0,
      contentId: a.cid ?? null,
      content: a.content,
    })),
  };
}

/** Strip Re:/Fwd: prefixes and collapse whitespace so replies thread together. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fw|fwd|aw|sv|vs)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Automated mail we never send to the AI: bounces, auto-replies, bulk senders. */
export function isAutomatedMail(parsed: Pick<ParsedEmail, "headers" | "from" | "subject">): string | null {
  const h = parsed.headers;
  const lower = (k: string) => (h[k] ?? h[k.toLowerCase()] ?? "").toLowerCase();
  if (lower("auto-submitted") && lower("auto-submitted") !== "no") return "auto-submitted header";
  if (/^(bulk|junk|list)$/.test(lower("precedence"))) return "bulk precedence";
  if (lower("x-auto-response-suppress") || lower("x-autoreply") || lower("x-autorespond")) return "auto-reply header";
  if (h["list-unsubscribe"] || h["List-Unsubscribe"]) return "list-unsubscribe header";
  if (/^(mailer-daemon|postmaster)@/i.test(parsed.from.address)) return "bounce sender";
  if (/^(automatic reply|out of office|delivery status notification|undeliverable)/i.test(parsed.subject)) return "auto-reply subject";
  return null;
}

/** Text before the first quoted reply block, for classification and snippets. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{5,120} wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^From: .+/.test(line) && out.length > 0 && /^Sent: |^Date: /.test(lines[lines.indexOf(line) + 1] ?? "")) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function makeSnippet(text: string, max = 160): string {
  const t = stripQuotedReply(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
