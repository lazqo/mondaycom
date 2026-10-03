/**
 * The one line a prepared email gains when the proposal PDF is attached. It only changes the draft's
 * wording: the email still needs Chris's approval and his Send.
 */
export const ATTACHMENT_LINE = "Please find the quotation attached for your review.";

const SIGN_OFF = /^(thanks|thank you|many thanks|kind regards|regards|cheers|ngā mihi|nga mihi)\b/i;

/** Add the line before the sign-off (or at the end), unless the email already mentions an attachment. */
export function withAttachmentLine(body: string): string {
  if (/\battached\b|\battachment\b/i.test(body)) return body;
  const lines = body.replace(/\s+$/, "").split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SIGN_OFF.test(lines[i].trim())) {
    at = i;
    break;
  }
  if (at < 0) return `${lines.join("\n")}\n\n${ATTACHMENT_LINE}`;
  const before = lines.slice(0, at);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  return [...before, "", ATTACHMENT_LINE, "", ...lines.slice(at)].join("\n");
}

/** Take the line out again (only the exact line this CRM added). */
export function withoutAttachmentLine(body: string): string {
  if (!body.includes(ATTACHMENT_LINE)) return body;
  return body
    .split("\n")
    .filter((l) => l.trim() !== ATTACHMENT_LINE)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
