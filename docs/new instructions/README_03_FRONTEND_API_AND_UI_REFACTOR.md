# Frontend API Client and UI Refactor README

## Objective

Make the WorkWell frontend maintainable enough for the next product features. Two changes are required:

1. Replace global fetch monkey-patching with an explicit typed API client.
2. Split large pages, especially Measure Studio, into focused components and hooks.

## Files to inspect

- `frontend/components/auth-provider.tsx`
- `frontend/app/login/page.tsx`
- `frontend/app/(dashboard)/studio/[id]/page.tsx`
- `frontend/app/(dashboard)/runs/page.tsx`
- `frontend/app/(dashboard)/runs/[id]/page.tsx`
- `frontend/app/(dashboard)/cases/page.tsx`
- `frontend/app/(dashboard)/cases/[id]/page.tsx`
- `frontend/lib/status.ts`
- `frontend/lib/toast.ts`

## Part A: API client

The auth provider should stop overriding `window.fetch`. Create:

```text
frontend/lib/api/client.ts
frontend/lib/api/errors.ts
frontend/lib/api/types.ts
frontend/lib/api/hooks.ts
```

API client responsibilities:

- normalize `NEXT_PUBLIC_API_BASE_URL`
- attach bearer token explicitly
- parse JSON safely
- support empty responses
- throw typed errors for 400/401/403/404/500
- centralize unauthorized handling
- avoid global side effects

Example shape:

```ts
export class ApiClient {
  constructor(options: { token?: string | null; onUnauthorized?: () => void }) {}
  get<T>(path: string): Promise<T>;
  post<TRequest, TResponse>(path: string, body?: TRequest): Promise<TResponse>;
  put<TRequest, TResponse>(path: string, body?: TRequest): Promise<TResponse>;
  delete<TResponse>(path: string): Promise<TResponse>;
}
```

Auth provider should keep token/user state and expose token/client/hooks. A 401 should logout or redirect consistently.

Refactor gradually: runs pages, case detail, then Studio actions.

## Part B: Measure Studio componentization

Current Studio page likely handles measure load, value sets, OSHA refs, spec form, AI draft, Monaco, compile errors, test fixtures, activation readiness, version history, lifecycle modals, and tab rendering in one file.

Target structure:

```text
frontend/features/studio/
  hooks/useMeasureDetail.ts
  hooks/useMeasureActions.ts
  hooks/useValueSets.ts
  hooks/useOshaReferences.ts
  hooks/useActivationReadiness.ts
  components/StudioHeader.tsx
  components/StudioTabs.tsx
  components/ActivationReadinessCard.tsx
  components/SpecTab.tsx
  components/CqlTab.tsx
  components/ValueSetsTab.tsx
  components/TestsTab.tsx
  components/ReleaseApprovalTab.tsx
  components/VersionHistoryPanel.tsx
  components/LifecycleActionModals.tsx
  types.ts
```

The route page should only parse route params and render a shell.

## Studio UX improvements

### Unified readiness card

Show one card with:

- spec complete/pass/fail
- CQL compile status
- test fixture count and validation status
- value set count and unresolved count
- approval status
- activation blockers

### CQL editor

Current editor may use SQL language mode. Improve by registering minimal CQL highlighting or clearly labeling plaintext as CQL. Add compile error click-to-line if line/column metadata exists. Show warnings, referenced value sets, dependencies, and optionally CQL define outline.

### AI draft UX

AI Draft Spec must show:

- “AI-generated draft — review before saving.”
- provider/fallback used
- no autosave
- error/empty states
- clear audit note if possible

AI fills draft fields only. It must not approve, activate, close, or mark compliance.

### Lifecycle controls

Release tab should show:

- current status
- who can approve
- who can activate
- why action is disabled
- confirmation modals with consequences

## Runs UI improvements

Add scope controls:

- scope dropdown
- measure dropdown
- site dropdown
- employee field
- evaluation date picker
- run button with validation

Run detail should show status timeline, logs, outcome counts, outcome table, failure summary, case impact counts, and exports.

## Case detail improvements

Add clear sections:

1. Case summary
2. Why flagged
3. Structured CQL evidence
4. Actions and timeline
5. Attachments/evidence
6. Verification history
7. Audit events

Rerun-to-verify messaging must say closure depends on actual new CQL outcome.

## Acceptance criteria

- no global `window.fetch` monkey patch remains.
- typed API client used by refactored pages.
- Studio page split into hooks/components.
- readiness card visible.
- runs page supports scoped run controls.
- case detail separates evidence/actions/verification.
- `npm run lint` and `npm run build` pass.

## Implementation Progress

### Part A: API client — COMPLETE (2026-05-09)

- [x] `frontend/lib/api/errors.ts` — `ApiError` with typed status helpers
- [x] `frontend/lib/api/client.ts` — `ApiClient` with `get/post/put/delete/postForm/downloadBlob`
- [x] `frontend/lib/api/hooks.ts` — `useApi()` composing `useAuth()` + `ApiClient`
- [x] `frontend/components/auth-provider.tsx` — `window.fetch` monkey-patch removed
- [x] `app/(dashboard)/layout.tsx` migrated
- [x] `app/(dashboard)/measures/page.tsx` migrated
- [x] `app/(dashboard)/programs/page.tsx` migrated
- [x] `app/(dashboard)/programs/[measureId]/page.tsx` migrated
- [x] `app/(dashboard)/runs/page.tsx` migrated (evidence download via `downloadBlob`)
- [x] `app/(dashboard)/cases/page.tsx` migrated
- [x] `app/(dashboard)/cases/[id]/page.tsx` migrated (evidence download via `downloadBlob`)
- [x] `app/(dashboard)/studio/[id]/page.tsx` migrated
- [x] `app/(dashboard)/admin/page.tsx` migrated
- [x] `app/login/page.tsx` intentionally unchanged (no token at login time)
- [x] lint exit 0, build all 12 routes pass

### Part B: Measure Studio componentization — PENDING

- [ ] `frontend/features/studio/hooks/useMeasureDetail.ts`
- [ ] `frontend/features/studio/hooks/useMeasureActions.ts`
- [ ] `frontend/features/studio/hooks/useValueSets.ts`
- [ ] `frontend/features/studio/hooks/useOshaReferences.ts`
- [ ] `frontend/features/studio/hooks/useActivationReadiness.ts`
- [ ] `frontend/features/studio/components/StudioHeader.tsx`
- [ ] `frontend/features/studio/components/StudioTabs.tsx`
- [ ] `frontend/features/studio/components/ActivationReadinessCard.tsx`
- [ ] `frontend/features/studio/components/SpecTab.tsx`
- [ ] `frontend/features/studio/components/CqlTab.tsx`
- [ ] `frontend/features/studio/components/ValueSetsTab.tsx`
- [ ] `frontend/features/studio/components/TestsTab.tsx`
- [ ] `frontend/features/studio/components/ReleaseApprovalTab.tsx`
- [ ] Route page `studio/[id]/page.tsx` trimmed to param parsing + shell render
