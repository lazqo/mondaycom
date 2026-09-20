import { formatDateTime } from "@/lib/utils";
import { LEAD_STATUS_META, type LeadStatus } from "@/lib/constants";

type Item = {
  id: string;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
  actorName: string | null;
};

const FIELD_LABELS: Record<string, string> = {
  name: "Lead",
  company: "Company",
  phone: "Phone",
  email: "Email",
  service: "Service",
  site: "Site",
  status: "Status",
  assignedToId: "Assigned to",
  followUpAt: "Follow-up",
  lastContactAt: "Last contact",
  source: "Source",
  notes: "Notes",
};

function describe(item: Item): string {
  const d = item.detail ?? {};
  switch (item.action) {
    case "created":
      return "created this";
    case "converted":
      return "converted this lead to a customer";
    case "archived":
      return "archived this";
    case "scheduled":
      return "scheduled this job";
    case "unscheduled":
      return "removed the schedule";
    case "status_changed": {
      const changes = (d.changes as Record<string, { from?: unknown; to?: unknown }> | undefined) ?? {};
      const to = changes.status?.to as string | undefined;
      const label = to && to in LEAD_STATUS_META ? LEAD_STATUS_META[to as LeadStatus].label : (to ?? (d.to as string));
      const via = d.via ? ` via ${String(d.via)}` : "";
      return `changed status to ${label}${via}`;
    }
    case "updated": {
      const changes = (d.changes as Record<string, unknown> | undefined) ?? d;
      const keys = Object.keys(changes).filter((k) => k !== "updatedAt");
      if (keys.length === 0) return "updated this";
      return `updated ${keys.map((k) => FIELD_LABELS[k] ?? k).join(", ")}`;
    }
    default:
      return item.action.replace(/_/g, " ");
  }
}

export function ActivityFeed({ items }: { items: Item[] }) {
  if (items.length === 0) return <p className="text-sm text-gray-500">No activity yet.</p>;
  return (
    <ol className="space-y-3">
      {items.map((it) => (
        <li key={it.id} className="text-sm">
          <p className="text-gray-800">
            <span className="font-medium">{it.actorName ?? "System"}</span> {describe(it)}
          </p>
          <p className="text-xs text-gray-500">{formatDateTime(it.createdAt)}</p>
        </li>
      ))}
    </ol>
  );
}
