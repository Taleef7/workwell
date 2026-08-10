# Sprint 0 — Critical Demo Fixes

> **For agentic workers:** Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement task-by-task.

**Goal:** Eliminate every visible defect that immediately undermines credibility when Doug or any reviewer first opens the live application. No new features — only fix what is visibly broken or embarrassing.

**Branch:** `fix/sprint-0-demo-polish`

**Prerequisites:** None. This sprint is the starting point.

**Estimated effort:** 1–2 days

---

## Issue 0.1 — Sidebar Shows "Work..." and "MVP Dashboard Shell"

### Current Behavior
The application sidebar header renders the truncated text **"Work..."** (the product name is wider than the container) and directly below it reads **"MVP Dashboard Shell"** in smaller text. "MVP Dashboard Shell" is scaffolding text that was never replaced during development. Both are visible to any user who logs in and look at the left navigation.

**Evidence:** Live at `https://workwell-measure-studio.vercel.app/programs` after login.

### Desired Behavior
The sidebar header shows the full product name **"WorkWell Measure Studio"** without truncation, with a meaningful subtitle or none at all. "MVP Dashboard Shell" must not appear anywhere in the production UI.

### Root Cause
The layout component (`frontend/app/(dashboard)/layout.tsx`) contains hardcoded placeholder text for the app name that was set during initial scaffolding and never updated. The container div likely has a fixed or `min-w` that is too narrow for the full product name at the font size used.

### Files to Modify
- `frontend/app/(dashboard)/layout.tsx` — app name text and subtitle text
- `frontend/app/(dashboard)/layout.tsx` — CSS/Tailwind classes on the sidebar header container

### Implementation Steps

**Step 1: Read the current layout file**
```bash
# Open frontend/app/(dashboard)/layout.tsx and find the sidebar header section
# Search for "MVP", "Dashboard Shell", or the short name
```

Locate the sidebar header element. It will look something like:
```tsx
<div className="sidebar-header">
  <span className="app-name">WorkWell</span>
  <span className="app-subtitle">MVP Dashboard Shell</span>
</div>
```
or it may be rendering from a Link or a logo component.

**Step 2: Replace the app name and subtitle**

Change the app name to the full product name and remove/replace the subtitle:
```tsx
{/* Before */}
<div className="flex flex-col">
  <span className="font-bold text-sm truncate">WorkWell</span>
  <span className="text-xs text-muted-foreground">MVP Dashboard Shell</span>
</div>

{/* After */}
<div className="flex flex-col">
  <span className="font-bold text-sm leading-tight">WorkWell</span>
  <span className="text-xs text-muted-foreground leading-tight">Measure Studio</span>
</div>
```

If there is a WW logo mark or icon, render it:
```tsx
<div className="flex items-center gap-2 px-2 py-3">
  <div className="w-7 h-7 rounded bg-foreground flex items-center justify-center flex-shrink-0">
    <span className="text-background font-bold text-xs">WW</span>
  </div>
  <div className="flex flex-col min-w-0">
    <span className="font-semibold text-sm leading-tight">WorkWell</span>
    <span className="text-xs text-muted-foreground leading-tight">Measure Studio</span>
  </div>
</div>
```

**Step 3: Fix truncation by adding `min-w-0` and removing `truncate`**

The parent flex container must have `min-w-0` to allow children to shrink below their natural width. The text element should use `whitespace-nowrap overflow-hidden text-ellipsis` only if space is truly limited, or use a two-line stacked layout as shown above.

**Step 4: Verify in browser at 1280px and 1440px widths**

The sidebar is typically 200–220px. "WorkWell Measure Studio" at 14px bold will wrap at ~180px. Use the two-line "WorkWell / Measure Studio" stacked layout to avoid any truncation.

**Step 5: Commit**
```bash
git add frontend/app/(dashboard)/layout.tsx
git commit -m "fix(ui): replace MVP placeholder with WorkWell Measure Studio branding in sidebar"
```

### Acceptance Criteria
- [ ] No occurrence of "MVP Dashboard Shell" anywhere in the visible UI
- [ ] App name renders in full without truncation at 1280px viewport
- [ ] Sidebar header identifies the product clearly
- [ ] No `truncate` or `...` on the product name

### Recommendation
Use the two-line stacked layout: "WorkWell" bold on line 1, "Measure Studio" smaller on line 2. Add a simple WW monogram badge (dark square with white WW letters) as a logo mark — takes 10 lines of Tailwind and makes the sidebar look intentional. Don't try to fit the full name on one line.

---

## Issue 0.2 — `/programs/overview` Returns 500 / Hangs Indefinitely

### Current Behavior
Navigating to `https://workwell-measure-studio.vercel.app/programs/overview` renders "Loading program detail..." and never resolves. The page spinner never stops. Console shows errors. This is because the Next.js route `app/(dashboard)/programs/[measureId]/page.tsx` treats `overview` as a `measureId` UUID, attempts to parse or fetch it as a UUID, and fails.

**Evidence:** Observed live. The commit `a609ea2` claims to fix "programs/overview 500" but the route is still broken in live production.

### Desired Behavior
`/programs/overview` either:
- (Option A) Redirects to `/programs` (the programs overview is already at `/programs`), OR
- (Option B) The Programs Overview page is accessible at `/programs` only and the `/programs/overview` URL is never produced by any link in the app

### Root Cause
The `[measureId]` dynamic route catches all path segments including the literal string `"overview"`. When the backend receives `GET /api/programs/overview/trend` or similar, it tries to parse `"overview"` as a UUID and fails with a 400/500.

Additionally, the prior fix may have been applied to the backend but not to the frontend routing, or may have been reverted in a subsequent deploy.

### Files to Modify
- `frontend/app/(dashboard)/programs/[measureId]/page.tsx` — add guard for non-UUID `measureId`
- `frontend/app/(dashboard)/programs/overview/page.tsx` — create a redirect page (optional)

### Implementation Steps

**Step 1: Add a guard in `[measureId]/page.tsx` for non-UUID segments**

At the top of the page component, before any data fetching:
```tsx
// frontend/app/(dashboard)/programs/[measureId]/page.tsx
import { redirect } from 'next/navigation'

export default function ProgramDetailPage({ params }: { params: { measureId: string } }) {
  // Guard: 'overview' is not a valid measure UUID — redirect to programs root
  if (params.measureId === 'overview' || !isValidUUID(params.measureId)) {
    redirect('/programs')
  }
  // ... rest of component
}

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
}
```

**Step 2: Alternatively, create a static `overview/page.tsx` that redirects**

Next.js will prefer a static route `programs/overview` over the dynamic `programs/[measureId]`:
```tsx
// frontend/app/(dashboard)/programs/overview/page.tsx
import { redirect } from 'next/navigation'

export default function ProgramsOverviewRedirect() {
  redirect('/programs')
}
```

This is cleaner and doesn't require UUID validation in the dynamic page.

**Step 3: Search for any link that generates `/programs/overview`**
```bash
grep -r "programs/overview" frontend/
```
If found, fix the links to point to `/programs` directly.

**Step 4: Verify the fix**
- Navigate to `https://workwell-measure-studio.vercel.app/programs/overview` — should redirect to `/programs`
- Navigate to `/programs/{valid-uuid}` — should still load the program detail page

**Step 5: Commit**
```bash
git add frontend/app/(dashboard)/programs/
git commit -m "fix(routing): redirect /programs/overview to /programs, guard non-UUID measureId"
```

### Acceptance Criteria
- [ ] `GET /programs/overview` redirects to `/programs` within 1 second
- [ ] No "Loading program detail..." infinite spinner
- [ ] Valid UUID-based program detail pages still render correctly
- [ ] No 500 errors in browser console when visiting `/programs/overview`

### Recommendation
Use Option B (static `overview/page.tsx` redirect). It's the cleanest solution and future-proof — if someone creates a measure named "overview" in the future, the static route will still win.

---

## Issue 0.3 — Global Search Bar is Non-Functional

### Current Behavior
The global search bar (`Global search by employee name or ID`) is rendered in the header on every dashboard page. Typing any text produces no visible result — no dropdown, no results panel, no navigation. The input appears to accept text but does nothing with it.

**Evidence:** Tested live on `/programs`, `/cases`, `/runs`.

### Desired Behavior
**Option A (wire it up — 1–2 hours):** Typing in the search box fires a debounced `GET /api/cases?search={query}` or employee lookup, and shows a dropdown of matching employees/cases. Clicking a result navigates to that employee profile or case detail.

**Option B (hide it — 15 minutes):** If wiring it up is deferred to Sprint 3, remove the search bar from the header entirely or replace it with a `<!-- TODO: Sprint 3 -->` comment and render nothing in its place. A non-functional search bar in a demo is actively harmful — it signals "this is fake."

**Recommendation: Implement Option B now (hide), implement Option A in Sprint 3.**

### Root Cause
The search bar component exists in `frontend/app/(dashboard)/layout.tsx` and likely writes to a global context (`GlobalFilterContext`) but no component subscribes to that context to show results, or the API call was never wired up.

### Files to Modify
- `frontend/app/(dashboard)/layout.tsx` — hide or wire the search bar
- `frontend/components/global-filter-context.tsx` — examine current state

### Implementation Steps (Option B — Hide for now)

**Step 1: Find the search input in layout.tsx**
```tsx
// Locate the element — looks something like:
<input
  type="text"
  placeholder="Global search by employee name or ID"
  className="..."
  value={searchQuery}
  onChange={...}
/>
```

**Step 2: Comment it out or replace with a placeholder**
```tsx
{/* Global search — wired in Sprint 3 */}
{/* <GlobalSearchBar /> */}
```

Or if you prefer to keep the UI slot but disable it:
```tsx
<div className="hidden" aria-hidden="true" />
```

**Step 3: Commit**
```bash
git add frontend/app/(dashboard)/layout.tsx
git commit -m "fix(ui): hide non-functional global search bar (to be implemented in Sprint 3)"
```

### Acceptance Criteria
- [ ] No non-functional search bar visible in the dashboard header (Option B)
- [ ] OR search bar produces visible results when text is typed (Option A)
- [ ] Typing text does not throw console errors

---

## Issue 0.4 — Admin Nav Item Visible to Non-Admin Roles

### Current Behavior
The "Admin" link in the left navigation sidebar is visible to all authenticated users, including those with `ROLE_CASE_MANAGER`. When a Case Manager clicks Admin, the page renders with a red error banner: **"Error: You don't have permission to perform this action."** The page skeleton loads (scheduler section, integration health, etc.) but all sections are empty or in error state.

**Evidence:** Tested live with `cm@workwell.dev` credentials.

### Desired Behavior
The Admin nav item is only visible when the authenticated user holds `ROLE_ADMIN`. Non-admin users do not see the nav item. If a non-admin navigates to `/admin` directly (via URL bar), they see a clean, styled "Access Denied" or "Admin access required" page — not a permission error banner mixed with an empty page skeleton.

### Root Cause
The sidebar navigation renders all nav items unconditionally without checking the user's role from the auth context. The admin page itself does enforce role checks (correctly returning 403 from the API) but the UI doesn't gate visibility of the nav item.

### Files to Modify
- `frontend/app/(dashboard)/layout.tsx` — conditionally render Admin nav item
- `frontend/app/(dashboard)/admin/page.tsx` — add a clean access denied gate
- `frontend/components/auth-provider.tsx` — ensure `user.role` or `user.roles` is exposed

### Implementation Steps

**Step 1: Check what the auth context exposes**

Read `frontend/components/auth-provider.tsx` and confirm that `useAuth()` (or equivalent hook) exposes the current user's role. It should decode the JWT and expose something like:
```tsx
interface AuthContext {
  user: { email: string; role: string; roles: string[] } | null
  token: string | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}
```

If `role`/`roles` is not exposed, parse it from the JWT payload:
```ts
// In auth-provider.tsx, after decoding the JWT:
const payload = JSON.parse(atob(token.split('.')[1]))
const roles: string[] = payload.roles ?? payload.authorities ?? []
```

**Step 2: Add `isAdmin` helper to auth context**
```tsx
// In auth-provider.tsx
const isAdmin = user?.roles?.includes('ROLE_ADMIN') ?? false
// expose in context value
```

**Step 3: Conditionally render Admin nav in layout**
```tsx
// In frontend/app/(dashboard)/layout.tsx
const { isAdmin } = useAuth()

// In the nav items list:
{isAdmin && (
  <NavItem href="/admin" icon={<Settings className="h-4 w-4" />}>
    Admin
  </NavItem>
)}
```

**Step 4: Add access-denied gate in admin page**
```tsx
// At the top of frontend/app/(dashboard)/admin/page.tsx
const { isAdmin } = useAuth()

if (!isAdmin) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-3">
      <ShieldAlert className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Admin access required</h2>
      <p className="text-sm text-muted-foreground">
        Your current role does not have access to this section.
        Contact your administrator to request access.
      </p>
    </div>
  )
}
```

**Step 5: Commit**
```bash
git add frontend/app/(dashboard)/layout.tsx frontend/app/(dashboard)/admin/page.tsx frontend/components/auth-provider.tsx
git commit -m "fix(auth): hide Admin nav from non-admin roles, add clean access-denied gate"
```

### Acceptance Criteria
- [ ] "Admin" nav item is not visible when logged in as Case Manager
- [ ] Navigating to `/admin` as Case Manager shows a clean "Admin access required" message
- [ ] "Admin" nav item is visible when logged in as Admin (`admin@workwell.dev`)
- [ ] No red error banner appears for any user on any page

---

## Issue 0.5 — Login Page Has No Branding or Demo Credentials Hint

### Current Behavior
The login page is a centered white card with the text "WorkWell Login" and a subtitle "Use your assigned credentials to sign in." There is no logo, no product color identity, no tagline, no demo credential hint. This is the entry point for any demo reviewer and it looks like an unstyled placeholder.

**Evidence:** Screenshot captured live at `https://workwell-measure-studio.vercel.app/login`.

### Desired Behavior
The login page:
1. Shows a **WW logo mark** or icon (even a simple styled monogram)
2. Shows the full product name **"WorkWell Measure Studio"**
3. Shows a tagline like **"OSHA Surveillance Intelligence"** or **"Policy-to-CQL compliance operations"**
4. Includes a demo credentials hint: `Demo: cm@workwell.dev / Workwell123!` — or a "Use demo credentials" button that pre-fills the form

### Root Cause
The login page was scaffolded with minimal styling and never received branding or UX polish.

### Files to Modify
- `frontend/app/login/page.tsx` — add branding, tagline, demo hint

### Implementation Steps

**Step 1: Update the login page layout and branding**
```tsx
// frontend/app/login/page.tsx
export default function LoginPage() {
  return (
    <div className="min-h-screen bg-muted flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo + Product Identity */}
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-xl bg-foreground flex items-center justify-center">
            <span className="text-background font-bold text-lg">WW</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">WorkWell</h1>
          <p className="text-sm text-muted-foreground">Measure Studio</p>
          <p className="text-xs text-muted-foreground italic">OSHA Surveillance Intelligence</p>
        </div>

        {/* Login Card */}
        <div className="bg-background rounded-xl border shadow-sm p-6 space-y-4">
          <div>
            <h2 className="font-semibold">Sign in</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Use your assigned credentials</p>
          </div>
          {/* ... existing form fields ... */}
        </div>

        {/* Demo Credentials Hint */}
        <div className="text-center">
          <p className="text-xs text-muted-foreground">
            Demo access:{' '}
            <button
              type="button"
              className="underline text-foreground"
              onClick={() => {
                setEmail('cm@workwell.dev')
                setPassword('Workwell123!')
              }}
            >
              Fill demo credentials
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Ensure `NEXT_PUBLIC_DEMO_MODE` is not required for the hint**

The hint button directly sets state — it does not require `NEXT_PUBLIC_DEMO_MODE=true`. The demo mode flag controls auto-prefill on page load; a click-to-fill button is fine in any mode.

**Step 3: Verify the form still submits correctly after pre-fill**

Test: click "Fill demo credentials" → fields populate → click "Sign in" → redirects to `/programs`.

**Step 4: Commit**
```bash
git add frontend/app/login/page.tsx
git commit -m "fix(ui): add WW branding, tagline, and demo credentials hint to login page"
```

### Acceptance Criteria
- [ ] Login page shows a logo mark (WW monogram acceptable)
- [ ] Product name "WorkWell Measure Studio" is visible on login page
- [ ] A demo credential hint or "Fill demo credentials" button is present
- [ ] Clicking the demo hint pre-fills email and password fields
- [ ] Login flow still works correctly after pre-fill

---

## Issue 0.6 — Status Enum Values Are Displayed as Raw API Strings

### Current Behavior
Throughout the UI, status values appear as raw database/API enum strings:
- `MISSING_DATA` instead of "Missing Data"
- `DUE_SOON` instead of "Due Soon"
- `ROLE_CASE_MANAGER` instead of "Case Manager" (in the header badge)
- `ALL_PROGRAMS` instead of "All Programs" (in run history)
- `COMPLIANT`, `OVERDUE`, `EXCLUDED` — these are readable but still ALLCAPS

**Evidence:** Status badges on Programs Overview, Cases list, Run history, and the user role badge in the top header.

### Desired Behavior
All status values rendered in the UI use human-readable title-case labels. The raw enum strings are only used internally for API calls and filtering logic.

### Root Cause
Components render the API response value directly without mapping it through a display label function. The `frontend/lib/status.ts` utility may exist but is not consistently applied.

### Files to Modify
- `frontend/lib/status.ts` — add or extend display label maps
- `frontend/app/(dashboard)/programs/page.tsx` — apply labels to outcome badge chips
- `frontend/app/(dashboard)/cases/page.tsx` — apply labels to status column
- `frontend/app/(dashboard)/runs/page.tsx` — apply labels to scope and status columns
- `frontend/app/(dashboard)/layout.tsx` — apply label to role badge in header

### Implementation Steps

**Step 1: Create a comprehensive label map in `frontend/lib/status.ts`**
```ts
// frontend/lib/status.ts

export const OUTCOME_LABELS: Record<string, string> = {
  COMPLIANT: 'Compliant',
  DUE_SOON: 'Due Soon',
  OVERDUE: 'Overdue',
  MISSING_DATA: 'Missing Data',
  EXCLUDED: 'Excluded',
}

export const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  EXCLUDED: 'Excluded',
}

export const PRIORITY_LABELS: Record<string, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
}

export const ROLE_LABELS: Record<string, string> = {
  ROLE_ADMIN: 'Admin',
  ROLE_CASE_MANAGER: 'Case Manager',
  ROLE_AUTHOR: 'Author',
  ROLE_APPROVER: 'Approver',
  ROLE_VIEWER: 'Viewer',
  ROLE_MCP_CLIENT: 'MCP Client',
  CASE_MANAGER: 'Case Manager', // without ROLE_ prefix
  ADMIN: 'Admin',
  AUTHOR: 'Author',
}

export const SCOPE_LABELS: Record<string, string> = {
  ALL_PROGRAMS: 'All Programs',
  MEASURE: 'Measure',
  SITE: 'Site',
  EMPLOYEE: 'Employee',
  CASE: 'Case',
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  RUNNING: 'Running',
  REQUESTED: 'Requested',
  QUEUED: 'Queued',
  PARTIAL_FAILURE: 'Partial Failure',
  CANCELLED: 'Cancelled',
}

export const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: 'Manual',
  SCHEDULED: 'Scheduled',
  CASE_RERUN: 'Case Rerun',
}

export function labelFor(map: Record<string, string>, value: string): string {
  return map[value] ?? value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
```

**Step 2: Apply labels in the Programs page outcome badges**
```tsx
// In programs/page.tsx wherever outcome badges are rendered:
import { OUTCOME_LABELS, labelFor } from '@/lib/status'

// Replace:
<Badge>{outcome.status}</Badge>

// With:
<Badge>{labelFor(OUTCOME_LABELS, outcome.status)}</Badge>
```

**Step 3: Apply role label in layout header**
```tsx
// In layout.tsx:
import { ROLE_LABELS, labelFor } from '@/lib/status'

// Replace:
<Badge variant="outline">{user.role}</Badge>

// With:
<Badge variant="outline">{labelFor(ROLE_LABELS, user.role)}</Badge>
```

**Step 4: Apply scope and run status labels in runs page**
```tsx
import { SCOPE_LABELS, RUN_STATUS_LABELS, TRIGGER_LABELS, labelFor } from '@/lib/status'

// In run rows:
<td>{labelFor(SCOPE_LABELS, run.scopeType)}</td>
<td>{labelFor(RUN_STATUS_LABELS, run.status)}</td>
<td>{labelFor(TRIGGER_LABELS, run.triggerType)}</td>
```

**Step 5: Apply status labels in cases page**
```tsx
import { STATUS_LABELS, PRIORITY_LABELS, OUTCOME_LABELS, labelFor } from '@/lib/status'

<td>{labelFor(STATUS_LABELS, caseItem.status)}</td>
<td>{labelFor(PRIORITY_LABELS, caseItem.priority)}</td>
<td>{labelFor(OUTCOME_LABELS, caseItem.currentOutcomeStatus)}</td>
```

**Step 6: Commit**
```bash
git add frontend/lib/status.ts frontend/app/(dashboard)/
git commit -m "fix(ui): humanize all status enum values to title-case display labels"
```

### Acceptance Criteria
- [ ] No `MISSING_DATA`, `DUE_SOON`, `ALL_PROGRAMS`, `ROLE_CASE_MANAGER` visible in UI
- [ ] Role badge in header shows "Case Manager" not "CASE_MANAGER"
- [ ] Run history scope shows "All Programs" not "ALL_PROGRAMS"
- [ ] Outcome badges on Programs Overview show "Missing Data", "Due Soon", etc.
- [ ] `labelFor()` gracefully handles unknown values by converting `_` to spaces

---

## Issue 0.7 — Console Errors on Login Page Load

### Current Behavior
The browser console shows **3 errors** when the login page first loads, before any credentials are entered. These are visible to any reviewer who opens browser devtools.

**Evidence:** Captured in Playwright console log at `console-2026-05-14T23-36-58-127Z.log`.

### Desired Behavior
Zero console errors on login page load. The login page is unauthenticated — it should make no API calls that could fail.

### Root Cause (to investigate)
Likely causes:
1. A component in the layout is attempting to fetch protected API endpoints before checking auth state
2. A missing favicon or asset 404
3. A CSP (Content Security Policy) violation
4. An uncaught promise rejection from the auth context initializing

### Files to Modify
- `frontend/app/login/page.tsx` — ensure no premature API calls
- `frontend/components/auth-provider.tsx` — ensure initialization doesn't trigger 401 errors
- `frontend/app/(dashboard)/layout.tsx` — ensure layout doesn't load for unauthenticated routes

### Implementation Steps

**Step 1: Identify the actual errors**
```bash
# Read the console log file from the Playwright session
cat ".playwright-mcp/console-2026-05-14T23-36-58-127Z.log"
```

Note the exact error messages and stack traces.

**Step 2: If errors are API 401/403 from premature fetches**

The auth provider likely tries to validate the stored token on mount, which fires a request. If the request fails (no token or expired token), it logs an error. Fix by catching the error silently:
```ts
// In auth-provider.tsx
useEffect(() => {
  const storedToken = localStorage.getItem('workwell_token')
  if (!storedToken) return  // don't attempt validation without a token
  
  validateToken(storedToken).catch(() => {
    // Token invalid or expired — clear it silently
    localStorage.removeItem('workwell_token')
    setUser(null)
  })
}, [])
```

**Step 3: If errors are 404 for assets**

Check `frontend/public/` for a favicon. Next.js expects `favicon.ico` at the root. Create a simple one if missing:
```bash
# Create a minimal favicon — use any 16x16 .ico file
# Or add to next.config.js:
# The default Next.js favicon is at app/favicon.ico
```

**Step 4: Verify login page loads with zero console errors**

Open `https://workwell-measure-studio.vercel.app/login` with devtools open. Console must show zero red errors.

**Step 5: Commit**
```bash
git commit -m "fix(auth): suppress console errors on unauthenticated login page load"
```

### Acceptance Criteria
- [ ] Zero console errors when `/login` page loads without an existing session
- [ ] Zero console errors when `/login` page loads with an expired token
- [ ] Auth context initializes without triggering visible error states

---

## Issue 0.8 — Run History Page Is Unreadable (No Pagination)

### Current Behavior
The `/runs` page loads all run records in a single flat list with no pagination, no virtualization, and no summary grouping. With 40+ runs, the page becomes an extremely long scroll. At viewport width, the table columns compress and become unreadable. The run timestamps and IDs are displayed in a verbose format that takes excessive column space.

**Evidence:** Screenshot captured live — the full-page screenshot shows 40+ runs in a dense unformatted list.

### Desired Behavior
The runs page shows the most recent 20 runs by default, with a "Load more" button or page controls. The table has stable column widths. Timestamps use a compact relative format ("2 hours ago") with the full timestamp on hover.

### Root Cause
The `GET /api/runs` backend endpoint supports a `limit` query parameter but the frontend does not pass one — it fetches all runs. No client-side pagination or virtual scrolling is implemented.

### Files to Modify
- `frontend/app/(dashboard)/runs/page.tsx` — add limit parameter and pagination controls

### Implementation Steps

**Step 1: Add `limit=20` to the initial runs fetch**
```tsx
// In runs/page.tsx, find the runs fetch call:
const runs = await api.get<Run[]>('/api/runs')

// Change to:
const [limit, setLimit] = useState(20)
const runs = await api.get<Run[]>(`/api/runs?limit=${limit}`)
```

**Step 2: Add a "Load more" button**
```tsx
{runs.length >= limit && (
  <div className="text-center py-4">
    <Button
      variant="outline"
      onClick={() => setLimit(prev => prev + 20)}
    >
      Load more runs
    </Button>
  </div>
)}
```

**Step 3: Humanize timestamps using a relative format**
```tsx
function relativeTime(dateString: string): string {
  const date = new Date(dateString)
  const diff = Date.now() - date.getTime()
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

// In the table row:
<td title={run.startedAt}>
  {relativeTime(run.startedAt)}
</td>
```

**Step 4: Commit**
```bash
git add frontend/app/(dashboard)/runs/page.tsx
git commit -m "fix(runs): add pagination limit=20 and relative timestamps to run history"
```

### Acceptance Criteria
- [ ] Runs page initially loads ≤ 20 runs
- [ ] "Load more" button fetches next 20
- [ ] Timestamps show relative format ("2h ago") with full timestamp on hover
- [ ] Table columns are stable and readable at 1280px viewport

---

## Sprint 0 Definition of Done

All of the following must be true before Sprint 0 is considered complete:

- [ ] Live app at `workwell-measure-studio.vercel.app` shows "WorkWell / Measure Studio" in sidebar with no truncation
- [ ] "MVP Dashboard Shell" does not appear anywhere in the UI
- [ ] `/programs/overview` redirects to `/programs` without error
- [ ] Global search bar is hidden (or functional)
- [ ] Admin nav item is not visible to Case Manager role
- [ ] Navigating to `/admin` as Case Manager shows a clean access-denied message
- [ ] Login page has a logo mark, product name, and demo credentials hint
- [ ] All status enums show human-readable labels (no `MISSING_DATA`, `DUE_SOON`, `ROLE_CASE_MANAGER`)
- [ ] Zero console errors on login page load
- [ ] Runs page shows ≤ 20 runs initially with a "Load more" control
- [ ] Deployed to Vercel and verified in live browser

**Branch to merge:** `fix/sprint-0-demo-polish`
**PR title:** `fix: Sprint 0 — critical demo polish and visible bug fixes`
