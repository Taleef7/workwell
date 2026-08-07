# `@work-well/*` — what ships, what it promises, and where it sits

> Roadmap M-C / C4. Driving ADR: **ADR-063**. Companion contract doc: `docs/COMPLIANCE_API.md`
> (ADR-061), which is the HTTP surface; this is the library surface.

Locked decision 5 makes the engine and its packaging the primary deliverable. This file is the part an
integrator reads before taking a dependency: what is published, what a version number promises, and —
the question that comes up first in every conversation — how this relates to the FHIR measure library
everyone already knows.

---

## 1. What ships

| Package | Dependencies | What it answers |
|---|---|---|
| **`@work-well/measure-engine`** | `cql-execution`, `cql-exec-fhir` | *Is this subject compliant with this measure?* Executes pre-compiled ELM against a FHIR R4 bundle and returns the outcome plus per-define evidence. |
| **`@work-well/measure-codegen`** | none | *What CQL expresses this rule?* Declarative rule params → canonical CQL. Authoring-time only. |

### What deliberately does not ship

- **`@work-well/official-executor`** — the sole home of `fqm-execution`, and the package boundary *is*
  the ADR-026 quarantine. Publishing it would advertise, as a `@work-well` product, exactly the
  dependency the engine package exists to keep out of its own manifest.
- **`@work-well/example-consumer`** — a test (ADR-062), not a sample.
- **Measure content.** No catalog, no compiled ELM, no value-set expansions (ADR-059). WorkWell's
  registry names occupational measures and its bundled expansions are, by their own docblock, *"the
  codes the synthetic corpus stamps."* Content is constructor input, and it is **required** — an engine
  with an empty catalog reports `MISSING_DATA` for a whole roster, which is indistinguishable from a
  genuinely ineligible population.

---

## 2. Positioning: it composes `fqm-execution`, it does not compete with it

This is the first question anyone familiar with the ecosystem asks, so it gets a direct answer.

**[`fqm-execution`](https://github.com/projecttacoma/fqm-execution)** (Project Tacoma / MITRE) takes a
published FHIR **Measure bundle** — Measure, Libraries, ValueSets — and calculates it end to end,
producing a MeasureReport. It is the reference implementation for FHIR-based measure calculation, and it
is very good at that job.

**`@work-well/measure-engine`** sits one layer down. It takes **compiled ELM** and a patient bundle and
returns the per-define expression results. It has no concept of a Measure resource, no bundle unpacking,
and no MeasureReport.

Both sit on the same runtime core: `cql-execution`. That is the honest framing of the relationship —
they are neighbours on a stack, not rivals for a slot.

### How WorkWell itself uses both

This is the strongest evidence for the claim, because it is a choice we made against our own package:

- **Official CMS eCQMs run on `fqm-execution`, not on our engine.** CMS122 and CMS125 evaluate the
  published QI-Core artifacts through `@work-well/official-executor` on the demo/production stack
  (ADR-045/046). Nicole's correction — *run the official published CQL, never reauthor* — is a standing
  rule, and reimplementing bundle-level calculation to avoid a dependency would break it.
- **Everything else runs on `@work-well/measure-engine`.** The occupational and surveillance measures
  where no official definition exists, and where the value is content nobody publishes rather than
  content everybody can download.

### When each one is the right choice

| Take `fqm-execution` when | Take `@work-well/measure-engine` when |
|---|---|
| You have a published Measure bundle and want a MeasureReport | You have compiled ELM and want the defines |
| You want gaps-in-care, `$care-gaps`, DEQM outputs | You want per-define evidence to drive an operational workflow |
| Node is your only target | You need a Cloudflare-style worker or a browser bundle — no `node:` builtins here |
| Bundle-level terminology handling is what you want | You want to inject your own `ValueSetResolver` |

**We are not claiming to be faster, more conformant, or more correct than `fqm-execution`.** No such
comparison has been run, and until one has, the claim would be unsupported. What is measured is narrower
and stated where it belongs: our CQL language conformance against `cqframework/cql-tests`
(`docs/evidence/CQL_TESTS_2026-08-05.md`, ADR-060) and our agreement with the measure stewards' own
expected results (`docs/STANDARDS_CONFORMANCE.md`).

**One independence caveat worth carrying**, because it matters when either package is cited as an
oracle: `fqm-testify` and `deqm-test-server` both *wrap* `fqm-execution`, so neither is an independent
check on it. Java `cqf-fhir-cr` is.

---

## 3. Versioning

**Semver, currently pre-1.0** — `0.MINOR.PATCH`.

Under semver, `0.x` has no compatibility guarantee at all. That is too weak to be useful and too vague
to hold anyone to, so the operating rule is narrower:

| Change | Bump |
|---|---|
| Removing or retyping an export; changing evaluation semantics for the same inputs | **minor** (`0.1` → `0.2`) |
| Adding an export; adding an optional field; a fix that changes no supported behaviour | **patch** |

That is deliberately the *stricter* reading — pre-1.0, a minor bump is where breakage is allowed to
live, so a patch never breaks you. **Pin to a minor range (`~0.1.0`), not a caret**, until 1.0.

**1.0 is not a calendar milestone.** It is reached when the surface has survived a consumer outside MIE,
and not before. Publishing a `1.0` because the code feels finished would assert a stability that nothing
has tested.

### What a version does *not* cover

- **`evaluate()`'s output for a given measure** depends on the ELM you inject, the value sets your
  resolver returns, and the bundle you pass. None of those is versioned by this package. Two runs of the
  same engine version can and should differ when the content differs — that is the whole point of
  ADR-059.
- **`cql-execution`'s own behaviour.** It is a caret range (`^3.3.2`). Our measured conformance figures
  are against a specific version and are re-measured, not assumed, on upgrade (ADR-060).

---

## 4. Provenance

Published from `.github/workflows/publish-packages.yml`, which runs `pnpm publish` with
`NPM_CONFIG_PROVENANCE` and `publishConfig.provenance` set — npm then attests which commit, workflow and
runner produced each tarball, so a consumer can verify the package against this source rather than
trusting the registry. Provenance requires a public repository, and this one is public.

**Status (2026-08-07): PUBLISHED.** Both packages are on the public registry at **`0.1.0`**, each with a
**SLSA provenance attestation** (`slsa.dev/provenance/v1`) signed by GitHub Actions and recorded in
sigstore's transparency log.

```bash
npm view @work-well/measure-engine      # 59 files, 134 kB unpacked
npm view @work-well/measure-codegen     # 13 files,  51 kB unpacked, zero dependencies
```

The claim is stated this precisely because it has a trivial external check, and it was verified the way
that matters rather than by reading the workflow's exit code: both were installed from npm into an empty
directory — no workspace, no clone — and the engine evaluated `example-consumer`'s measure there,
returning COMPLIANT, OVERDUE and `unknown measure 'audiogram'`, with codegen emitting CQL. **That
discharges the caveat `example-consumer` has carried since ADR-062** — it is now a consumer outside the
repo, not merely outside the app.

**Two things worth knowing about the publish path.** The **dry run does not exercise `NPM_TOKEN`** — it
stops before the publish step, by design, so a mis-scoped token passes it and fails the real run. And the
registry is **not immediately consistent**: `npm view` returned 404 for several minutes after a publish
that had already succeeded and signed provenance. Do not read an early 404 as a failed publish; read the
workflow log for `+ @work-well/<pkg>@<version>`.

What *is* verified today, on every PR, is the harder half — `pnpm verify:publish` (CI's `packages` job)
builds real tarballs, installs them into a temp directory with a plain `npm install`, and then runs the
engine on a measure it has never seen and typechecks a TypeScript consumer against the packed
declarations. That closes the gap `example-consumer` names in its own README: it proves the *tarball*
contains what a consumer needs, not merely that the source tree is separable.

Owner steps to first publish are listed at the top of the workflow file.

---

## 5. Scope name

**`@work-well/*`**. What was decided on **2026-08-05** was *neutrality* — a scope of our own rather than
`@mieweb/*`. The spelling was settled on **2026-08-06** and the two are worth keeping apart, because only
the first was a judgement.

`@workwell` is not available and never was: an unrelated **unscoped** package named `workwell` exists on
npm, and npm refuses an **org** name colliding with an existing **package** name. Hyphen rather than
underscore is npm convention — `@work_well` reads as a typo in an install command. Full reasoning, and the
pre-flight check that missed it, in the ADR-063 amendment.

`@mieweb/*` remains a live option to pitch once the packages have proven themselves; the roadmap's wording
is *"pitch Doug on `@mieweb/*` once proven."* Renaming a scope later costs a deprecation notice on two
packages that have no external consumers yet — which is precisely why this is the cheap moment to defer
that decision rather than force it.
