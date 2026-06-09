# WorkWell Measure Studio Frontend

This directory contains the Next.js dashboard for WorkWell Measure Studio.

## What lives here

- `/programs` overview dashboard
- `/cases` worklist and case detail flows
- `/studio/[id]` measure authoring views
- `/admin` operational controls
- `/login` demo login surface

## Local development

```bash
pnpm install
pnpm lint
pnpm build
pnpm dev
```

## Environment variables

- `NEXT_PUBLIC_API_BASE_URL` - backend API base URL
- `NEXT_PUBLIC_APP_NAME` - display name shown in the UI
- `NEXT_PUBLIC_DEMO_MODE` - set to `true` only for local demo runs; production builds fail if it is enabled

## Safety notes

- The login page demo prefill is a local convenience only.
- Do not ship `NEXT_PUBLIC_DEMO_MODE=true` in production.
- The frontend build will stop if demo mode is left on during a production build.

## UI & theming

- Built on MIE's [`@mieweb/ui`](https://ui.mieweb.org) component library (Tailwind 4).
- **Dark mode** (`lib/useTheme.ts`) + **Enterprise Health brand** default with a **runtime brand switcher** (`lib/useBrand.ts`) in the header. Persisted theme/brand are applied **before first paint** by a pre-hydration inline script (`components/theme-script.tsx`) to avoid a flash; the hooks handle subsequent runtime changes.
- Brand stylesheets live in `public/brands/*.css`; re-sync them from the package with `pnpm sync:brands` after upgrading `@mieweb/ui`.
- Import `@mieweb/ui` only from `"use client"` modules — its barrel runs `React.createContext` at load and breaks Server Component builds (see `components/client-providers.tsx`).
- Full migration details + known gaps (e.g. DataVis NITRO grid is deferred): `MIEWEB-UI-MIGRATION.md`.

## Notes

- The app uses the Next.js App Router.
- UI behavior depends on the backend being available.
- The demo login is intentionally stubbed for the internship review flow.
