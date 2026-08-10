# Contributing to WorkWell Measure Studio

Thanks for contributing. This repository values small, verifiable, and well-documented changes.

## Before you start

1. Read [`docs/guide/`](docs/guide/README.md) — the maintained explanation of how the system works,
   in ten chapters. Start there before the reference docs.
2. Check [`docs/ROADMAP_2026-08-04.md`](docs/ROADMAP_2026-08-04.md) for what is planned, and
   [`docs/JOURNAL.md`](docs/JOURNAL.md) for what happened recently.
3. Search existing issues and PRs to avoid duplicate effort.

Sprints 0–7 are all merged. [`docs/archive/sprints/`](docs/archive/sprints/README.md) is kept as
historical context — it is not a work queue, and nothing in it is waiting to be picked up.

## Development setup

### Backend

```bash
cd backend-ts
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

### Frontend

```bash
cd frontend
npm install
npm run lint
npm run test
npm run build
npm run dev
```

## Branch and commit conventions

- Branch naming: `feat/<slug>` or `fix/<slug>`, one branch per task. (Sprint-numbered branch names
  like `feat/sprint-1-<slug>` appear in the history from before the sprints closed out; don't add
  new ones.)
- Commit format:
  - `<type>(<scope>): <summary>`
  - Example: `fix(security): restrict MAT export to approver roles`

## Pull request expectations

- Keep PRs focused and scoped.
- Include test evidence in the PR description.
- Update docs in the same PR when behavior/API changes.
- Avoid unrelated refactors in feature/fix PRs.

## PR checklist

- [ ] Backend and/or frontend tests pass locally for affected areas
- [ ] Lint/type/build checks pass for affected areas
- [ ] Docs updated (`docs/guide/` chapter for behaviour you changed, `docs/JOURNAL.md`, `README`,
      and relevant design/runtime docs)
- [ ] Security and audit invariants preserved
- [ ] No secrets added to source control

## Dependencies and security scanning

CodeQL analyses this repository on every push and pull request to `main`, covering both the
TypeScript sources and the workflow files themselves. Findings appear in the Security tab.
Dependabot vulnerability alerts are on for every ecosystem. Version-update PRs run for GitHub
Actions, `frontend`, `wcdb-fhir-shim` and `e2e`. They do **not** run for `backend-ts`: its pnpm
workspace takes members from a git submodule, which Dependabot never initializes, so an updater
there fails at workspace resolution before it reaches any dependency.
[`.github/dependabot.yml`](.github/dependabot.yml) carries the reproduction. Backend dependencies are
bumped by hand; alerts still cover them.

Four of them are bumped only deliberately: `@cqframework/cql`, `cql-execution`, `cql-exec-fhir` and
`fqm-execution`. Their versions are inputs to numbers this project publishes — the committed ELM, the
published engine package's manifest, and the MADiE gate — so a bump can leave the suite green while
making a written claim untrue. Changing one is a PR that re-measures what it affects.

Adding a *new* dependency needs explicit approval and a documented reason, whether or not
Dependabot is involved.

## Code style notes

- Prefer existing patterns and module boundaries over introducing new abstractions.
- Keep behavior deterministic for compliance-critical paths.
- For AI-assisted paths: AI may assist authoring/explanations; AI must never decide compliance outcomes.
