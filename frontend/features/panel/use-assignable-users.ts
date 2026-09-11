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
  /**
   * The account's OWN spelling for an email that names it, case-insensitively; `undefined` when no
   * account does. Both the truth test and the display value come from here, because they are the same
   * question asked twice: the server matches case-insensitively, and a `<select>` matches exactly, so
   * a stored `CM@WorkWell.dev` is a valid assignee that no option's value equals. Answering only the
   * first half leaves the control blank over a case that is in fact assigned.
   */
  canonicalFor: (email: string) => string | undefined;
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

  const canonicalFor = useMemo(() => {
    const byLower = new Map(users.map((u) => [u.email.toLowerCase(), u.email]));
    return (email: string) => byLower.get(email.trim().toLowerCase());
  }, [users]);

  return { options, canonicalFor };
}
