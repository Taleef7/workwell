"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { GlobalFilterProvider, useGlobalFilters } from "@/components/global-filter-context";

const nav = [
  { href: "/programs", label: "Programs" },
  { href: "/worklist", label: "Worklist" },
  { href: "/measures", label: "Measures" },
  { href: "/studio", label: "Studio" },
  { href: "/runs", label: "Test Runs" },
  { href: "/admin", label: "Admin" }
];

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, logout } = useAuth();
  const api = useApi();
  const { siteId, setSiteId, datePreset, setDatePreset, from, to } = useGlobalFilters();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [worklistGapCount, setWorklistGapCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function loadSites() {
      try {
        const data = await api.get<string[]>("/api/programs/sites");
        if (mounted) setSites(data);
      } catch {
        if (mounted) setSites([]);
      }
    }
    void loadSites();
    return () => {
      mounted = false;
    };
  }, [api]);

  useEffect(() => {
    let mounted = true;
    async function loadWorklistGapCount() {
      try {
        const params = new URLSearchParams();
        params.set("status", "open");
        if (siteId) params.set("site", siteId);
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        const data = await api.get<Array<{ outreachRecordCount?: number }>>(`/api/cases?${params.toString()}`);
        const count = data.filter((item) => (item.outreachRecordCount ?? 0) === 0).length;
        if (mounted) setWorklistGapCount(count);
      } catch {
        if (mounted) setWorklistGapCount(0);
      }
    }
    void loadWorklistGapCount();
    return () => {
      mounted = false;
    };
  }, [api, siteId, from, to]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    const params = new URLSearchParams();
    if (siteId) params.set("site", siteId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (pathname?.startsWith("/cases")) {
      for (const key of ["status", "measureId", "priority", "assignee"] as const) {
        const value = searchParams.get(key);
        if (value) {
          params.set(key, value);
        }
      }
    }
    params.set("search", term);
    router.push(`/cases?${params.toString()}`);
    setMenuOpen(false);
  }

  const sharedFilterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (siteId) params.set("site", siteId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [siteId, from, to]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3">
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-sm md:hidden"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <Link href="/programs" className="flex shrink-0 items-center gap-2 rounded-md pr-2 focus:outline-none focus:ring-2 focus:ring-slate-400">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-bold text-white">
              WW
            </span>
            <span className="flex flex-col">
              <span className="text-base font-semibold leading-tight text-slate-950">WorkWell</span>
              <span className="text-xs leading-tight text-slate-500">Measure Studio</span>
            </span>
          </Link>
          <form className="ml-auto w-full max-w-md" onSubmit={submitSearch}>
            <input
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="Global search by employee name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          {user ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{user.email}</span>
              <span className="rounded-full bg-emerald-100 px-2 py-1 font-medium text-emerald-800">{user.role.replace("ROLE_", "")}</span>
              <button type="button" onClick={logout} className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-100">
                Logout
              </button>
            </div>
          ) : null}
          <select
            className="rounded border border-slate-300 px-2 py-2 text-xs text-slate-700"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          >
            <option value="">All Sites</option>
            {sites.map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-slate-300 px-2 py-2 text-xs text-slate-700"
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value as "7d" | "30d" | "90d" | "all")}
          >
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
            <option value="all">All Time</option>
          </select>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] md:grid-cols-[220px_1fr]">
        <aside className={`${menuOpen ? "block" : "hidden"} border-r border-slate-200 bg-white p-4 md:block`}>
          <nav className="space-y-2">
            {nav.map((item) => {
              const active = pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={sharedFilterQuery ? `${item.href}?${sharedFilterQuery}` : item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`block rounded-md px-3 py-2 text-sm ${active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
                >
                  <span className="flex items-center gap-2">
                    <span>{item.label}</span>
                    {item.href === "/worklist" && worklistGapCount > 0 ? (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${active ? "bg-white/15 text-white" : "bg-rose-100 text-rose-700"}`}>
                        {worklistGapCount}
                      </span>
                    ) : null}
                  </span>
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <GlobalFilterProvider>
        <DashboardShell>{children}</DashboardShell>
      </GlobalFilterProvider>
    </Suspense>
  );
}
