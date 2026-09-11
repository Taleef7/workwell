"use client";

/**
 * The accounts a case may be assigned to, as options rather than as a hint.
 *
 * The case list's bulk control was a free-text input with no suggestions at all, and the case detail
 * page offered a `<datalist>`, which a browser only reveals once the typed text already prefixes an
 * entry. Both assume the operator knows an account's email address. The pilot's quality staffer did
 * not, typed her own name, got nothing, and could not assign a case from the work list — so the
 * options are now the control on every surface that assigns.
 *
 * `/api/users/assignable` is deployment-scoped (ADR-070's pilot accounts on Maui, the demo accounts
 * elsewhere), which is also what the server validates an assignment against — so what the list offers
 * and what the server accepts come from one source.
 */
import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";

export type AssignableUser = { email: string; role: string };

/** The value that clears an assignment. Empty string is "no choice made", which is a different thing. */
export const UNASSIGN_VALUE = "__unassigned__";

export function useAssignableUsers(enabled = true): {
  /** `{value,label}` options: a placeholder, every assignable account, then "Unassign". */
  options: { value: string; label: string }[];
  /** True when the email is one the server will accept — the UI never offers an assignment that 400s. */
  isAssignable: (email: string) => boolean;
} {
  const api = useApi();
  const [users, setUsers] = useState<AssignableUser[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api
      .get<AssignableUser[]>("/api/users/assignable")
      .then((rows) => {
        if (!cancelled) setUsers(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  const options = useMemo(
    () => [
      { value: "", label: "Choose an assignee…" },
      ...users.map((u) => ({ value: u.email, label: u.email })),
      { value: UNASSIGN_VALUE, label: "Unassign" },
    ],
    [users],
  );

  const isAssignable = useMemo(() => {
    const emails = new Set(users.map((u) => u.email.toLowerCase()));
    return (email: string) => emails.has(email.trim().toLowerCase());
  }, [users]);

  return { options, isAssignable };
}
