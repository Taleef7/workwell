# AGENTS.md — `frontend/`

**The rules live in the repository root.** Read `../CLAUDE.md` first: it is the single source of truth
for the hard rules, the branch and ownership boundaries, the definition of done and the current focus
(`../AGENTS.md` says the same and exists for agents that read only `AGENTS.md`). Nothing in this file
replaces or narrows it.

Below is Next.js's own managed block, written and refreshed by `next dev`. It is version guidance for
this package, not a rule set — do not add project rules here, and do not edit inside the markers.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
