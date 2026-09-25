"use client";

import * as React from "react";
import { Paperclip } from "lucide-react";
import type { EmailAddress } from "@/db/schema";
import { Badge } from "@/components/ui";
import { EMAIL_CLASSIFICATION_META, type EmailClassification } from "@/lib/constants";
import { cn, formatDateTime } from "@/lib/utils";

type Msg = {
  id: string;
  direction: "inbound" | "outbound";
  fromName: string | null;
  fromAddress: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: Date;
  classification: EmailClassification;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
  sentBy: { id: string; name: string } | null;
  origin: "inbox" | "sent_folder" | "crm";
};

function fmtAddr(a: EmailAddress) {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function MessageCard({ email, mailboxAddress }: { email: Msg; mailboxAddress: string }) {
  const [showHtml, setShowHtml] = React.useState(false);
  const [expanded, setExpanded] = React.useState(true);
  const outbound = email.direction === "outbound";
  const meta = EMAIL_CLASSIFICATION_META[email.classification];
  return (
    <article className={cn("rounded-lg border bg-white shadow-sm", outbound ? "border-brand-200" : "border-gray-200")} data-testid={`message-${email.id}`}>
      <header className="flex cursor-pointer items-start justify-between gap-3 px-4 py-3" onClick={() => setExpanded((v) => !v)}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">
            {outbound
              ? `${email.sentBy?.name ?? email.fromName ?? "Get Secure"} <${email.fromAddress || mailboxAddress}>`
              : email.fromName
                ? `${email.fromName} <${email.fromAddress}>`
                : email.fromAddress}
          </p>
          <p className="truncate text-xs text-gray-500">
            to {email.to.map(fmtAddr).join(", ") || "—"}
            {email.cc.length ? ` · cc ${email.cc.map(fmtAddr).join(", ")}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
          {outbound ? (
            <Badge className="bg-brand-100 text-brand-800">{email.origin === "sent_folder" ? "Sent from Titan" : "Sent from CRM"}</Badge>
          ) : (
            <Badge className={`${meta.bg} ${meta.text}`}>{meta.label}</Badge>
          )}
          <span suppressHydrationWarning>{formatDateTime(email.receivedAt)}</span>
        </div>
      </header>
      {expanded ? (
        <div className="border-t border-gray-100 px-4 py-3">
          {email.htmlBody ? (
            <div className="mb-2 flex gap-2 text-xs">
              <button type="button" onClick={() => setShowHtml(false)} className={cn("rounded px-2 py-0.5", !showHtml ? "bg-gray-200 text-gray-900" : "text-gray-500 hover:bg-gray-100")}>
                Text
              </button>
              <button type="button" onClick={() => setShowHtml(true)} className={cn("rounded px-2 py-0.5", showHtml ? "bg-gray-200 text-gray-900" : "text-gray-500 hover:bg-gray-100")}>
                Original HTML
              </button>
            </div>
          ) : null}
          {showHtml && email.htmlBody ? (
            <iframe
              title="Original email"
              sandbox=""
              srcDoc={email.htmlBody}
              className="h-[480px] w-full rounded border border-gray-200 bg-white"
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800">{email.textBody || "(empty message)"}</pre>
          )}
          {email.attachments.length ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {email.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/attachments/${a.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    {a.filename} <span className="text-gray-400">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
