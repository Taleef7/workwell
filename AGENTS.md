# AGENTS.md — WorkWell Measure Studio

Operating manual for any AI coding agent (Claude Code, Codex, Cursor, …) working in this repo.

## There is exactly one rule set: `CLAUDE.md`

**Read `CLAUDE.md`. It is the single source of truth for the operating rules** — what this project is,
the tech stack and what may change it, the hard rules, branch and ownership boundaries, the definition
of done, working style, file conventions, stop-and-ask conditions, and the current focus.

This file used to mirror all of that, and the two copies drifted. As of **2026-07-29** the duplicate
was removed rather than re-synced, because two rule sets that disagree are worse than one:

- Every one of the nine hard rules had been reworded, and one had drifted **materially** — this file
  said a dependency named in a sprint file was "pre-approved", while `CLAUDE.md` requires explicit
  approval for any new dependency. `CLAUDE.md`'s stricter rule is the live one. The carve-out was
  moot anyway: `docs/archive/sprints/` is archived history, not an active queue.
- This file's phase note ("as of 2026-06-17") and its treatment of `docs/sprints/` as authoritative
  were both stale.
- It also carried its own `@`-import block that eagerly pulled in ~9 documents including
  `docs/DECISIONS.md` (176k chars). `CLAUDE.md` now imports five small, deliberately chosen files.

## Read before any task

1. `CLAUDE.md` — hard rules, current focus, build/verify commands, and the always-loaded doc set
2. `docs/JOURNAL.md` — newest entry on top; the source of truth for recent work

Do not re-add rule content here. If a rule needs changing, change it in `CLAUDE.md`.
