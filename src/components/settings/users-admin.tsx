"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { createUser, setUserActive, resetUserPassword, setUserRole } from "@/actions/users";
import { USER_ROLES, USER_ROLE_META, type UserRole } from "@/lib/constants";
import { Badge, Button, Dialog, Field, FormError, Input, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

type Row = { id: string; name: string; email: string; role: UserRole; active: boolean; createdAt: Date };

export function UsersAdmin({ users, meId }: { users: Row[]; meId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setError(null);
    startTransition(async () => {
      const res = await createUser(data);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.refresh();
    });
  }

  function toggle(u: Row) {
    startTransition(async () => {
      const res = await setUserActive(u.id, !u.active);
      if (!res.ok) alert(res.error);
      router.refresh();
    });
  }

  function reset(u: Row) {
    const pw = prompt(`New password for ${u.name} (min 8 characters):`);
    if (!pw) return;
    startTransition(async () => {
      const res = await resetUserPassword(u.id, pw);
      if (!res.ok) alert(res.error);
      else alert("Password updated.");
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Staff</h1>
          <p className="text-sm text-gray-500">People who can sign in. Technicians see only My Day, the calendar, jobs and customer details.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add staff member
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-medium text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Added</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2 font-medium text-gray-900">
                  {u.name} {u.id === meId ? <span className="text-xs text-gray-500">(you)</span> : null}
                </td>
                <td className="px-3 py-2 text-gray-700">{u.email}</td>
                <td className="px-3 py-2 text-gray-700">
                  <select
                    aria-label={`Role for ${u.name}`}
                    className="h-8 rounded-md border border-gray-300 bg-white px-2 text-sm"
                    value={u.role}
                    disabled={pending || u.id === meId}
                    onChange={(e) =>
                      startTransition(async () => {
                        const res = await setUserRole(u.id, e.target.value);
                        if (!res.ok) alert(res.error);
                        router.refresh();
                      })
                    }
                  >
                    {USER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {USER_ROLE_META[r].label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <Badge className={u.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}>{u.active ? "Active" : "Inactive"}</Badge>
                </td>
                <td className="px-3 py-2 text-gray-500">{formatDateTime(u.createdAt)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => reset(u)} disabled={pending}>
                      Reset password
                    </Button>
                    {u.id !== meId ? (
                      <Button size="sm" variant="secondary" onClick={() => toggle(u)} disabled={pending}>
                        {u.active ? "Deactivate" : "Activate"}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title="Add staff member">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name *" htmlFor="u-name">
            <Input id="u-name" name="name" required autoFocus />
          </Field>
          <Field label="Email *" htmlFor="u-email">
            <Input id="u-email" name="email" type="email" required />
          </Field>
          <Field label="Temporary password *" htmlFor="u-password">
            <Input id="u-password" name="password" type="text" minLength={8} required />
          </Field>
          <Field label="Role" htmlFor="u-role">
            <Select id="u-role" name="role" defaultValue="member">
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {USER_ROLE_META[r].label} — {USER_ROLE_META[r].description}
                </option>
              ))}
            </Select>
          </Field>
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add staff member"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
