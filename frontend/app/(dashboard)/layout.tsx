"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  BookOpen,
  ClipboardList,
  FileClock,
  LogOut,
  Menu,
  Settings,
  Shield,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { GlobalFilterProvider, useGlobalFilters } from "@/components/global-filter-context";
import { ROLE_LABELS, labelFor } from "@/lib/status";
import { GlobalSearch } from "@/components/GlobalSearch";

const nav = [
  { href: "/programs", label: "Programs", icon: BarChart3 },
  { href: "/cases", label: "Cases", icon: Shield },
  { href: "/worklist", label: "Worklist", icon: ClipboardList },
  { href: "/measures", label: "Measures", icon: BookOpen },
  { href: "/studio", label: "Studio", icon: FileClock },
  { href: "/runs", label: "Test Runs", icon: Activity },
  { href: "/admin", label: "Admin", icon: Settings, adminOnly: true },
] as const;

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { token, user, logout } = useAuth();
  const api = useApi();
  const { siteId, setSiteId, datePreset, setDatePreset, from, to } = useGlobalFilters();
  const isAdmin = user?.role === "ROLE_ADMIN";
  const roleLabel = user ? labelFor(ROLE_LABELS, user.role) : null;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sites, setSites] = useState<string[]>([]);
  const [worklistGapCount, setWorklistGapCount] = useState(0);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Close sidebar on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (sidebarOpen && sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setSidebarOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!token) return;
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
    return () => { mounted = false; };
  }, [api, token]);

  useEffect(() => {
    if (!token) return;
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
    return () => { mounted = false; };
  }, [api, siteId, from, to, token]);

  const sharedFilterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (siteId) params.set("site", siteId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [siteId, from, to]);

  if (!token) {
    return <div className="min-h-dvh bg-slate-50" />;
  }

  return (
    <div className="min-h-dvh bg-slate-50">
      {/* ── Mobile sidebar backdrop ──────────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm lg:hidden"
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <aside
        ref={sidebarRef}
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 ease-out lg:translate-x-0 lg:shadow-none ${
          sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4">
          <Link
            href="/programs"
            className="flex items-center gap-2.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[10px] font-bold tracking-[0.2em] text-white">
              WW
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-slate-950">WorkWell</span>
              <span className="text-xs text-slate-500">Measure Studio</span>
            </span>
          </Link>
          <button
            type="button"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden focus:outline-none focus:ring-2 focus:ring-slate-400"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-0.5">
            {nav.map((item) => {
              if ("adminOnly" in item && item.adminOnly && !isAdmin) return null;
              const active = pathname?.startsWith(item.href);
              const Icon = item.icon;
              const hasGap = item.href === "/worklist" && worklistGapCount > 0;
              return (
                <li key={item.href}>
                  <Link
                    href={sharedFilterQuery ? `${item.href}?${sharedFilterQuery}` : item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                      active
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                    }`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${active ? "text-white" : "text-slate-400"}`} />
                    <span className="flex-1">{item.label}</span>
                    {hasGap && (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${active ? "bg-white/15 text-white" : "bg-rose-100 text-rose-700"}`}>
                        {worklistGapCount}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Sidebar footer: user + logout */}
        {user && (
          <div className="shrink-0 border-t border-slate-200 p-3">
            <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white">
                {user.email.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-900">{user.email}</p>
                <p className="text-[10px] text-slate-500">{roleLabel}</p>
              </div>
              <button
                type="button"
                onClick={logout}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
                aria-label="Log out"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* ── Main area (header + content) ────────────────────────────── */}
      <div className="flex min-h-dvh flex-col lg:pl-64">
        {/* Header */}
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur">
          {/* Mobile hamburger */}
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 lg:hidden focus:outline-none focus:ring-2 focus:ring-slate-400"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Mobile logo */}
          <Link
            href="/programs"
            className="flex items-center gap-2 rounded-lg lg:hidden focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-[9px] font-bold tracking-[0.18em] text-white">
              WW
            </span>
            <span className="text-sm font-semibold text-slate-950">WorkWell</span>
          </Link>

          {/* Search — grows to fill */}
          <div className="flex-1">
            <GlobalSearch />
          </div>

          {/* Filters — hidden on mobile, visible md+ */}
          <div className="hidden items-center gap-2 md:flex">
            <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <select
                className="bg-transparent text-xs text-slate-700 outline-none"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                aria-label="Filter by site"
              >
                <option value="">All Sites</option>
                {sites.map((site) => (
                  <option key={site} value={site}>{site}</option>
                ))}
              </select>
            </div>
            <select
              className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700 outline-none"
              value={datePreset}
              onChange={(e) => setDatePreset(e.target.value as "7d" | "30d" | "90d" | "all")}
              aria-label="Date range"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </div>
        </header>

        {/* Mobile filters bar */}
        <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-100 bg-white px-4 py-2 md:hidden">
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <select
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 outline-none"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            aria-label="Filter by site"
          >
            <option value="">All Sites</option>
            {sites.map((site) => (
              <option key={site} value={site}>{site}</option>
            ))}
          </select>
          <select
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 outline-none"
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value as "7d" | "30d" | "90d" | "all")}
            aria-label="Date range"
          >
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
            <option value="all">All time</option>
          </select>
        </div>

        {/* Page content */}
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-slate-50" />}>
      <GlobalFilterProvider>
        <DashboardShell>{children}</DashboardShell>
      </GlobalFilterProvider>
    </Suspense>
  );
}
