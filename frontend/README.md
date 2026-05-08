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
- `NEXT_PUBLIC_DEMO_MODE` - set to `true` to prefill the demo login form locally

## Notes

- The app uses the Next.js App Router.
- UI behavior depends on the backend being available.
- The demo login is intentionally stubbed for the internship review flow.
