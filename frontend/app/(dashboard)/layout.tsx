"use client";

import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  FileClock,
  LogOut,
  Send,
  Settings,
  Shield,
} from "lucide-react";
import {
  AppHeader,
  AppHeaderSection,
  Select,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMobileToggle,
  SidebarNav,
  SidebarNavItem,
  SidebarProvider,
  SidebarToggle,
} from "@mieweb/ui";
import { useAuth } from "@/components/auth-provider";
import { ROLES, canManageCases, hasAnyRole } from "@/lib/rbac";
import { useApi } from "@/lib/api/hooks";
import { GlobalFilterProvider, useGlobalFilters } from "@/components/global-filter-context";
import { RunStatusProvider, useRunStatus } from "@/components/run-status-provider";
import { ROLE_LABELS, labelFor } from "@/lib/status";
import { GlobalSearch } from "@/components/GlobalSearch";
import { ThemeBrandSwitcher } from "@/components/theme-brand-switcher";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";
const [APP_BADGE, ...appRest] = APP_NAME.split(" ");
const APP_SUBTITLE = appRest.join(" ") || "Measure Studio";

// `roles` gates visibility to the authorities that can actually *use* the surface
// (mirrors backend-ts/src/auth/authorize.ts). Omit `roles` for read surfaces any
// authenticated role may browse (Programs, Measures, Runs). Operational surfaces
// (Cases, Worklist, Campaigns) are scoped to the roles whose API calls won't 403.
const nav = [
  { href: "/programs", label: "Programs", icon: BarChart3 },
  { href: "/cases", label: "Cases", icon: Shield, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/worklist", label: "Worklist", icon: ClipboardList, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/campaigns", label: "Campaigns", icon: Send, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/orders", label: "Orders", icon: ClipboardCheck, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/measures", label: "Measures", icon: BookOpen },
  { href: "/studio", label: "Studio", icon: FileClock, roles: [ROLES.AUTHOR, ROLES.APPROVER, ROLES.ADMIN] },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/admin", label: "Admin", icon: Settings, roles: [ROLES.ADMIN] },
] as const;

const DATE_PRESETS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

/** Global "a measure run is in progress" pill — visible on every dashboard screen, persists across
 *  navigation and reloads via RunStatusProvider, and links to /runs. */
function RunStatusIndicator() {
  const { isActive, status, evaluated } = useRunStatus();
  const router = useRouter();
  if (!isActive) return null;
  return (
    <button
      type="button"
      onClick={() => router.push("/runs")}
      title="A measure run is in progress — click to view"
      className="hidden items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800 transition hover:bg-blue-100 sm:flex dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
      <span>
        Run {status.toLowerCase()}
        {evaluated > 0 ? ` · ${evaluated} evaluated` : ""}
      </span>
    </button>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, user, logout } = useAuth();
  const api = useApi();
  const { siteId, setSiteId, datePreset, setDatePreset, from, to } = useGlobalFilters();
  const roleLabel = user ? labelFor(ROLE_LABELS, user.role) : null;
  const [sites, setSites] = useState<string[]>([]);
  const [worklistGapCount, setWorklistGapCount] = useState(0);

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
    return () => {
      mounted = false;
    };
  }, [api, token]);

  useEffect(() => {
    // The Worklist gap badge only exists for case-managing roles (the Worklist nav item is gated to
    // them), so don't pull the full open-cases list on every navigation/filter change for everyone.
    // (No setState here: non-managers never render the badge and the initial count is already 0.)
    if (!token || !canManageCases(user?.role)) return;
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
  }, [api, siteId, from, to, token, user]);

  const sharedFilterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (siteId) params.set("site", siteId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [siteId, from, to]);

  const siteOptions = useMemo(
    () => [{ value: "", label: "All Sites" }, ...sites.map((s) => ({ value: s, label: s }))],
    [sites],
  );

  if (!token) {
    return <div className="min-h-dvh bg-neutral-50 dark:bg-neutral-950" />;
  }

  const navItems = nav.filter((item) => !("roles" in item && item.roles) || hasAnyRole(user?.role, item.roles));

  return (
    <SidebarProvider>
      <div className="flex h-dvh overflow-hidden bg-neutral-50 dark:bg-neutral-950">
        {/* ── Sidebar (handles its own mobile drawer + backdrop) ───────── */}
        <Sidebar>
          <SidebarHeader>
            <button
              type="button"
              onClick={() => router.push("/programs")}
              className="flex items-center gap-2.5 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-[10px] font-bold tracking-[0.2em] text-white">
                WW
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{APP_BADGE}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">{APP_SUBTITLE}</span>
              </span>
            </button>
          </SidebarHeader>

          <SidebarContent>
            <SidebarNav>
              {navItems.map((item) => {
                const active = pathname?.startsWith(item.href) ?? false;
                const Icon = item.icon;
                const hasGap = item.href === "/worklist" && worklistGapCount > 0;
                const target = sharedFilterQuery ? `${item.href}?${sharedFilterQuery}` : item.href;
                return (
                  <SidebarNavItem
                    key={item.href}
                    label={item.label}
                    icon={<Icon className="h-5 w-5" />}
                    isActive={active}
                    badge={hasGap ? worklistGapCount : undefined}
                    onClick={() => router.push(target)}
                  />
                );
              })}
            </SidebarNav>
          </SidebarContent>

          {user && (
            <SidebarFooter>
              <div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-3 py-2.5 dark:bg-neutral-800">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600 text-[10px] font-bold text-white">
                  {user.email.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-100">{user.email}</p>
                  <p className="text-[10px] text-neutral-500 dark:text-neutral-400">{roleLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={logout}
                  className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                  aria-label="Log out"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </div>
            </SidebarFooter>
          )}
        </Sidebar>

        {/* ── Main area (header + content) ─────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <AppHeader>
            <AppHeaderSection align="left" className="min-w-0 flex-1 gap-2">
              <SidebarToggle />
              <SidebarMobileToggle />
              <div className="min-w-0 flex-1">
                <GlobalSearch />
              </div>
            </AppHeaderSection>
            <AppHeaderSection align="right" className="gap-2">
              <div className="hidden items-center gap-2 lg:flex">
                <Select
                  aria-label="Filter by site"
                  value={siteId}
                  onValueChange={setSiteId}
                  options={siteOptions}
                  size="sm"
                  className="w-36"
                />
                <Select
                  aria-label="Date range"
                  value={datePreset}
                  onValueChange={(v) => setDatePreset(v as "7d" | "30d" | "90d" | "all")}
                  options={[...DATE_PRESETS]}
                  size="sm"
                  className="w-36"
                />
              </div>
              <RunStatusIndicator />
              <ThemeBrandSwitcher />
            </AppHeaderSection>
          </AppHeader>

          {/* Mobile filters bar (header filters are lg-only) */}
          <div className="flex items-center gap-2 border-b border-neutral-200 bg-white px-4 py-2 lg:hidden dark:border-neutral-800 dark:bg-neutral-900">
            <Select
              aria-label="Filter by site"
              value={siteId}
              onValueChange={setSiteId}
              options={siteOptions}
              size="sm"
              className="flex-1"
            />
            <Select
              aria-label="Date range"
              value={datePreset}
              onValueChange={(v) => setDatePreset(v as "7d" | "30d" | "90d" | "all")}
              options={[...DATE_PRESETS]}
              size="sm"
              className="flex-1"
            />
          </div>

          <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-neutral-50 dark:bg-neutral-950" />}>
      <GlobalFilterProvider>
        <RunStatusProvider>
          <DashboardShell>{children}</DashboardShell>
        </RunStatusProvider>
      </GlobalFilterProvider>
    </Suspense>
  );
}
