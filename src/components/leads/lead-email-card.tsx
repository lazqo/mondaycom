import Link from "next/link";
import { Mail, Paperclip } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import { stripQuotedReply } from "@/lib/email/parse";

type Thread = {
  id: string;
  subject: string;
  emails: {
    id: string;
    direction: "inbound" | "outbound";
    fromName: string | null;
    fromAddress: string;
    subject: string;
    textBody: string | null;
    receivedAt: Date;
    hasAttachments: boolean;
  }[];
};

export function LeadEmailCard({ thread }: { thread: Thread | null | undefined }) {
  if (!thread) return null;
  const first = thread.emails.find((e) => e.direction === "inbound") ?? thread.emails[0];
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Mail className="h-4 w-4 text-gray-500" /> Original email
          </span>
        }
        action={
          <Link href={`/inbox/${thread.id}`} className="text-sm text-brand-700 hover:underline">
            Open thread ({thread.emails.length})
          </Link>
        }
      />
      {first ? (
        <div className="p-4 text-sm" data-testid="lead-original-email">
          <p className="font-medium text-gray-900">{first.subject || "(no subject)"}</p>
          <p className="text-xs text-gray-500">
            From {first.fromName ? `${first.fromName} <${first.fromAddress}>` : first.fromAddress} · {formatDateTime(first.receivedAt)}
            {first.hasAttachments ? <Paperclip className="ml-1 inline h-3 w-3" /> : null}
          </p>
          <pre className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-3 font-sans text-sm text-gray-800">
            {stripQuotedReply(first.textBody ?? "") || first.textBody || "(empty message)"}
          </pre>
          {thread.emails.length > 1 ? (
            <ul className="mt-3 space-y-1 text-xs text-gray-600">
              {thread.emails.slice(1).map((e) => (
                <li key={e.id}>
                  {e.direction === "outbound" ? "↗ Reply sent" : "↙ Received"} · {formatDateTime(e.receivedAt)} · {e.direction === "outbound" ? "from CRM" : e.fromName || e.fromAddress}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
