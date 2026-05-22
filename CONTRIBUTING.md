# Contributing to WorkWell Measure Studio

Thanks for contributing. This repository values small, verifiable, and well-documented changes.

## Before you start

1. Review [README.md](README.md) and relevant docs under [`docs/`](docs/).
2. For sprint-scoped work, review [`docs/sprints/README.md`](docs/sprints/README.md) and the target sprint file.
3. Search existing issues and PRs to avoid duplicate effort.

## Development setup

### Backend

```bash
cd backend
./gradlew.bat test
./gradlew.bat bootRun
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

- Branch naming:
  - `fix/sprint-0-<slug>`
  - `feat/sprint-1-<slug>`
  - or equivalent sprint-aligned branch naming used in this repo
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
- [ ] Docs updated (`README`, `docs/JOURNAL.md`, and relevant design/runtime docs)
- [ ] Security and audit invariants preserved
- [ ] No secrets added to source control

## Code style notes

- Prefer existing patterns and module boundaries over introducing new abstractions.
- Keep behavior deterministic for compliance-critical paths.
- For AI-assisted paths: AI may assist authoring/explanations; AI must never decide compliance outcomes.
