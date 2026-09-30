"use client";

import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  FileClock,
  ListChecks,
  LogOut,
  Send,
  Code2,
  Settings,
  Shield,
  Users,
  ListOrdered,
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
  useSidebar,
} from "@mieweb/ui";
import { useAuth } from "@/components/auth-provider";
import { ROLES, canManageCases, hasAnyRole } from "@/lib/rbac";
import { useApi } from "@/lib/api/hooks";
import { GlobalFilterProvider, useGlobalFilters } from "@/components/global-filter-context";
import { GlobalFilterGroup } from "@/components/global-filter-group";
import { RunStatusProvider, useRunStatus } from "@/components/run-status-provider";
import { ROLE_LABELS, labelFor } from "@/lib/status";
import { GlobalSearch } from "@/components/GlobalSearch";
import { ThemeBrandSwitcher } from "@/components/theme-brand-switcher";
import { canSeeEngineering } from "@/lib/public-demo";

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
  { href: "/compliance", label: "Compliance", icon: ListChecks },
  { href: "/people", label: "People", icon: Users, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  // The ACO's attributed lists (ADR-082). CM/ADMIN because EVERY method on /api/subject-lists is —
  // a member row is a raw identifier another system asserted, so the reads are gated too.
  { href: "/lists", label: "Lists", icon: ListOrdered, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/campaigns", label: "Campaigns", icon: Send, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/orders", label: "Orders", icon: ClipboardCheck, roles: [ROLES.CASE_MANAGER, ROLES.ADMIN] },
  { href: "/measures", label: "Measures", icon: BookOpen },
  { href: "/studio", label: "Studio", icon: FileClock, roles: [ROLES.AUTHOR, ROLES.APPROVER, ROLES.ADMIN] },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/admin", label: "Admin", icon: Settings, roles: [ROLES.ADMIN] },
  // The integration contract (ADR-068). No `roles`: the page and the document it renders are both public,
  // so every authenticated role can reach it — and so can anyone without an account.
  { href: "/api-docs", label: "API", icon: Code2 },
] as const;

const ENGINEERING_HREFS = new Set(["/measures", "/studio", "/runs", "/api-docs"]);

/**
 * The Programs pages report measurement-year figures, so a date range has nothing to scope there, and
 * scoping only some of a card's numbers set them against each other (#699). The control is hidden on
 * them; a range chosen elsewhere is kept in the URL for the pages that use it.
 */
const usesDateRange = (pathname: string | null): boolean =>
  !(pathname === "/programs" || (pathname?.startsWith("/programs/") ?? false));

const DATE_PRESETS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

/** A nav item is current on its own page and every page under it (`/cases/123` is Cases). */
function isNavActive(pathname: string | null, href: string): boolean {
  return !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
}

const navTestId = (href: string) => `nav-${href.slice(1)}`;

/** Global "a measure run is in progress" pill — visible on every dashboard screen, persists across
 *  navigation and reloads via RunStatusProvider, and links to /runs. */
function RunStatusIndicator() {
  const { isActive, status, evaluated } = useRunStatus();
  const router = useRouter();
  return (
    <>
      {/* Screen-reader announcement of run start/progress. Always mounted (so transitions are
          announced); completion is announced separately by the toast. */}
      <span role="status" aria-live="polite" className="sr-only">
        {isActive
          ? `Measure run ${status.toLowerCase()}${evaluated > 0 ? `, ${evaluated} evaluated` : ""}`
          : ""}
      </span>
      {isActive ? (
        <button
          type="button"
          onClick={() => router.push("/runs")}
          title="A measure run is in progress — click to view"
          aria-label={`Run ${status.toLowerCase()}${evaluated > 0 ? `, ${evaluated} evaluated` : ""}`}
          className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800 transition hover:bg-blue-100 sm:min-h-0 sm:min-w-0 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          <span className="hidden sm:inline">
            Run {status.toLowerCase()}
            {evaluated > 0 ? ` · ${evaluated} evaluated` : ""}
          </span>
        </button>
      ) : null}
    </>
  );
}

/**
 * The library Sidebar, made safe on a phone or tablet (#700). Below lg it is a drawer that slides off
 * screen when closed, but it stayed in the tab order (all twelve nav links, reached by an invisible
 * focus) and ignored Escape. Closed, it is now `inert` (out of the tab order and the accessibility tree,
 * with no effect on its slide); Escape closes it; focus moves into it on open and back to the menu
 * button on close; and it is `h-dvh`, so the footer's Log out is not under a phone browser's toolbar. On
 * the collapsed desktop rail it marks itself so the brand and the user card show only their icons.
 */
function ShellSidebar({ children }: { children: React.ReactNode }) {
  const { isMobileViewport, isMobileOpen, closeMobile, isCollapsed } = useSidebar();
  useEffect(() => {
    if (!isMobileViewport || !isMobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobileViewport, isMobileOpen, closeMobile]);
  // The open drawer is modal: it sits over the page behind a backdrop, so the page (and the skip link)
  // is inert while it is open, and focus moves into it. When it closes, focus goes back to the menu
  // button, but only if it was inside the drawer: a close the user did not make (a rotation to desktop
  // width and back) must not pull focus out of whatever they are typing in.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef(false);
  const closedDrawer = isMobileViewport && !isMobileOpen;
  const openDrawer = isMobileViewport && isMobileOpen;
  // `inert` is set on the library's <nav> directly: the component forwards no arbitrary attributes. A
  // layout effect, so where focus was is read before `inert` blurs it, and the attribute is off before
  // the focus below runs.
  useLayoutEffect(() => {
    const nav = shellRef.current?.querySelector<HTMLElement>("nav[data-slot=sidebar]");
    if (nav) {
      if (closedDrawer) returnFocus.current = nav.contains(document.activeElement);
      nav.inert = closedDrawer;
    }
    for (const id of ["shell-main", "skip-link"]) {
      const el = document.getElementById(id);
      if (el) el.inert = openDrawer;
    }
  }, [closedDrawer, openDrawer]);
  useEffect(() => {
    if (!isMobileViewport) return;
    if (isMobileOpen) {
      const items = shellRef.current?.querySelectorAll<HTMLElement>("[data-slot=sidebar-nav-item]");
      const current = shellRef.current?.querySelector<HTMLElement>('[data-slot=sidebar-nav-item][aria-current="page"]');
      (current ?? items?.[0])?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      document.querySelector<HTMLElement>('[aria-label="Open navigation"]')?.focus();
    }
  }, [isMobileViewport, isMobileOpen]);
  return (
    <div ref={shellRef} className="group/shell contents" data-rail={!isMobileViewport && isCollapsed ? "collapsed" : "open"}>
      <Sidebar className="h-dvh">{children}</Sidebar>
    </div>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, user, logout, reconnecting } = useAuth();
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
        // The badge is a COUNT, so ask the server for one: `outreach=none` narrows to open cases with
        // no OUTREACH_SENT record and `X-Total-Count` carries the full filtered match, while `limit=1`
        // keeps the body to a single row. Counting rows client-side capped the badge at the server's
        // default page (50) and made the backend load every open case on every navigation.
        const params = new URLSearchParams();
        params.set("status", "open");
        params.set("outreach", "none");
        params.set("limit", "1");
        if (siteId) params.set("site", siteId);
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        const { headers } = await api.getWithHeaders<unknown[]>(`/api/cases?${params.toString()}`);
        const count = Number(headers.get("X-Total-Count") ?? 0);
        if (mounted) setWorklistGapCount(Number.isFinite(count) ? count : 0);
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

  const navItems = nav.filter((item) => {
    if (ENGINEERING_HREFS.has(item.href) && !canSeeEngineering(user?.role)) {
      return false;
    }
    return !("roles" in item && item.roles) || hasAnyRole(user?.role, item.roles);
  });

  // The library's nav items carry no `aria-current` and forward no attributes, so a screen reader could
  // not tell which page is open; mark the active one after each render (#700). Cheap: a dozen nodes.
  useEffect(() => {
    for (const item of navItems) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${navTestId(item.href)}"]`);
      if (!el) continue;
      if (isNavActive(pathname, item.href)) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
  });

  if (!token) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
        {/* A page-load refresh waiting out a server restart (a deploy): the login is still good. The
            link is the way out if the server stays unreachable; it signs nothing out. */}
        {reconnecting ? (
          <div className="text-center text-sm text-neutral-600 dark:text-neutral-400">
            <p role="status" data-testid="auth-reconnecting">
              Reconnecting to the server…
            </p>
            <a href="/login" className="mt-2 inline-block underline hover:text-neutral-900 dark:hover:text-neutral-100">
              Sign in again
            </a>
          </div>
        ) : null}
      </div>
    );
  }

  const showDateRange = usesDateRange(pathname);

  return (
    <SidebarProvider>
      {/* Skip-to-content: the first focusable element, visually hidden until focused, lets keyboard users
          jump past the 12-item nav on every page (WCAG 2.4.1). */}
      <a
        id="skip-link"
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-neutral-900 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg dark:focus:bg-white dark:focus:text-neutral-900"
      >
        Skip to content
      </a>
      <div className="flex h-dvh overflow-hidden bg-neutral-50 dark:bg-neutral-950">
        {/* ── Sidebar (handles its own mobile drawer + backdrop) ───────── */}
        <ShellSidebar>
          <SidebarHeader>
            <button
              type="button"
              onClick={() => router.push("/programs")}
              className="flex items-center gap-2.5 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-[10px] font-bold tracking-[0.2em] text-white">
                WW
              </span>
              <span className="flex flex-col leading-tight group-data-[rail=collapsed]/shell:hidden">
                <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{APP_BADGE}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">{APP_SUBTITLE}</span>
              </span>
            </button>
          </SidebarHeader>

          <SidebarContent>
            <SidebarNav>
              {navItems.map((item) => {
                const active = isNavActive(pathname, item.href);
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
                    className="min-h-11 lg:min-h-0"
                    data-testid={navTestId(item.href)}
                  />
                );
              })}
            </SidebarNav>
          </SidebarContent>

          {user && (
            <SidebarFooter>
              <div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-3 py-2.5 group-data-[rail=collapsed]/shell:flex-col group-data-[rail=collapsed]/shell:gap-2 group-data-[rail=collapsed]/shell:px-1 dark:bg-neutral-800">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600 text-[10px] font-bold text-white">
                  {user.email.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1 group-data-[rail=collapsed]/shell:hidden">
                  <p className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-100">{user.email}</p>
                  <p className="text-[10px] text-neutral-500 dark:text-neutral-400">{roleLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={logout}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition lg:h-auto lg:w-auto lg:p-1.5 hover:bg-neutral-200 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                  aria-label="Log out"
                >
                  <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </div>
            </SidebarFooter>
          )}
        </ShellSidebar>

        {/* ── Main area (header + content) ─────────────────────────────── */}
        <div id="shell-main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <AppHeader>
            <AppHeaderSection align="left" className="min-w-0 flex-1 gap-2">
              <SidebarToggle />
              <SidebarMobileToggle className="inline-flex h-11 w-11 items-center justify-center focus:ring-0 focus-visible:ring-2" />
              <div className="min-w-0 flex-1">
                <GlobalSearch />
              </div>
            </AppHeaderSection>
            <AppHeaderSection align="right" className="gap-2">
              <GlobalFilterGroup className="hidden xl:flex">
                <Select
                  aria-label="Filter by site"
                  value={siteId}
                  onValueChange={setSiteId}
                  options={siteOptions}
                  size="sm"
                  className="w-36"
                />
                {showDateRange ? (
                  <Select
                    aria-label="Date range"
                    value={datePreset}
                    onValueChange={(v) => setDatePreset(v as "7d" | "30d" | "90d" | "all")}
                    options={[...DATE_PRESETS]}
                    size="sm"
                    className="w-36"
                  />
                ) : null}
              </GlobalFilterGroup>
              <RunStatusIndicator />
              {canSeeEngineering(user?.role) && <ThemeBrandSwitcher />}
            </AppHeaderSection>
          </AppHeader>

          {/* Filters bar below xl. The header's own filters start at xl: between 1024 and 1279px the
              search, both filters, the run pill and the theme controls did not fit one row (#700). */}
          <div className="border-b border-neutral-200 bg-white px-4 py-2 xl:hidden dark:border-neutral-800 dark:bg-neutral-900">
            <GlobalFilterGroup className="w-full">
              <Select
                aria-label="Filter by site"
                value={siteId}
                onValueChange={setSiteId}
                options={siteOptions}
                size="sm"
                className="flex-1"
              />
              {showDateRange ? (
                <Select
                  aria-label="Date range"
                  value={datePreset}
                  onValueChange={(v) => setDatePreset(v as "7d" | "30d" | "90d" | "all")}
                  options={[...DATE_PRESETS]}
                  size="sm"
                  className="flex-1"
                />
              ) : null}
            </GlobalFilterGroup>
          </div>

          {/* tabIndex=-1 so the skip link actually MOVES keyboard focus here (a non-focusable target
              only scrolls in some browsers, leaving focus back in the nav — defeating WCAG 2.4.1). */}
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6 focus:outline-none">
            {/* Content stops growing at 1600px, so a line of text or a card row stays readable on a wide
                monitor instead of stretching edge to edge (#700). */}
            <div className="mx-auto w-full max-w-[1600px]">{children}</div>
          </main>
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
