/**
 * The flip gate's roster reading is a shadow of the DEPLOYMENT's real roster (MM-1 U3; ROADMAP MM-1c(c):
 * "the official-only flip gate against Maui's own roster").
 *
 * Until U3 the CLI built its subjects from the 48-row occupational fixture filtered to the maui tenant,
 * through the official-only fixture bundles. U2 made Maui's roster the generated corpus, composed
 * through the same `compositeBundleSource` the run pipeline evaluates — so the gate was measuring a
 * roster the deployment no longer runs, and a corpus shape the artifact could not read would have
 * passed it. The gate now composes the deployment's directory and bundle source exactly as the run
 * pipeline does, with the measure under test routed HYPOTHETICALLY (what a flip would do), and the
 * report records what it evaluated so the JSON attached to a flip PR says whose roster it describes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gateMeasure, parseArgs, renderGate, rosterSubjectsFor, FlipGateUsageError } from "./official-flip-gate.ts";
import type { BatchAndSingle } from "./official-flip-snapshot.ts";
import { resolveDeploymentProfile } from "../../config/deployment-profile.ts";

const MAUI_ENV = { WORKWELL_INSTANCE: "maui", WORKWELL_MAUI_CORPUS_SIZE: "60", WORKWELL_OFFICIAL_MEASURES: "cms122,cms125" };

test("parseArgs accepts --subjects as a positive integer cap and rejects anything else", () => {
  assert.equal(parseArgs(["--measure", "cms137", "--subjects", "250"]).subjects, 250);
  assert.equal(parseArgs(["--measure", "cms137"]).subjects, undefined);
  assert.equal(parseArgs(["--measure", "cms137", "--subjects", "all"]).subjects, "all");
  assert.throws(() => parseArgs(["--measure", "cms137", "--subjects", "0"]), FlipGateUsageError);
  assert.throws(() => parseArgs(["--measure", "cms137", "--subjects", "ten"]), FlipGateUsageError);
});

test("on the Maui profile the roster is the corpus, routed as if the measure were flipped", () => {
  const { subjects, source } = rosterSubjectsFor("cms137", "2026-06-30", MAUI_ENV, resolveDeploymentProfile("maui"), { limit: 10 });
  assert.equal(subjects.length, 10);
  assert.deepEqual(subjects.slice(0, 2).map((s) => s.subjectId), ["pat-001", "pat-002"]);
  // A corpus bundle is the patient's WHOLE record: a Patient resource carrying the subject's own id.
  const bundle = subjects[0]!.bundle as { entry?: Array<{ resource?: { resourceType?: string; id?: string } }> };
  const patient = bundle.entry?.find((e) => e.resource?.resourceType === "Patient")?.resource;
  assert.equal(patient?.id, "pat-001");
  assert.deepEqual(source, {
    profile: "maui",
    directorySize: 60,
    evaluated: 10,
    routedAs: "cms122,cms125,cms137",
  });
});

test("without a cap the whole directory is evaluated, and a cap above it is not an error", () => {
  const whole = rosterSubjectsFor("cms2", "2026-06-30", MAUI_ENV, resolveDeploymentProfile("maui"));
  assert.equal(whole.subjects.length, 60);
  assert.equal(whole.source.evaluated, 60);
  const over = rosterSubjectsFor("cms2", "2026-06-30", MAUI_ENV, resolveDeploymentProfile("maui"), { limit: 500 });
  assert.equal(over.subjects.length, 60);
});

test("a measure outside the profile's set is refused up front, on every profile, with the profile named", () => {
  // Maui's corpus source deliberately does not gate `bundleForSubject` (it has no measure id to gate on),
  // so without this check the gate would happily build 20,000 corpus bundles for cms68 and print a report
  // about a measure the deployment can never run. And on the default profile cms137 has no official-only
  // fixture shape, so the old path produced `bundle: undefined` for every subject and crashed inside the
  // executor instead of saying why.
  assert.throws(
    () => rosterSubjectsFor("cms68", "2026-06-30", MAUI_ENV, resolveDeploymentProfile("maui"), { limit: 1 }),
    (error: unknown) => error instanceof FlipGateUsageError && /cms68/.test(String((error as Error).message)) && /maui/.test(String((error as Error).message)),
  );
  assert.throws(
    () => rosterSubjectsFor("cms137", "2026-06-30", { WORKWELL_OFFICIAL_MEASURES: "cms122,cms125" }, resolveDeploymentProfile("default"), { limit: 1 }),
    (error: unknown) => error instanceof FlipGateUsageError && /cms137/.test(String((error as Error).message)) && /default/.test(String((error as Error).message)),
  );
});

test("a measure already routed is not listed twice in the hypothetical routing", () => {
  const { source } = rosterSubjectsFor("cms125", "2026-06-30", MAUI_ENV, resolveDeploymentProfile("maui"), { limit: 1 });
  assert.equal(source.routedAs, "cms122,cms125");
});

test("the gate evaluates the roster in the run pipeline's chunks, not as one batch (review finding)", async () => {
  // The pipeline hands the executor 500 subjects at a time (ADR-075); one 20,000-bundle batch is a
  // different working set and a different failure surface. The chunk boundaries must not change the
  // counts, and a subject the executor drops in chunk 2 is still an evaluation error.
  const batches: number[] = [];
  const executor: BatchAndSingle = {
    async evaluateBatch(_measureId, subjects) {
      batches.push(subjects.length);
      const out = new Map<string, never>();
      for (const s of subjects) {
        if (s.subjectId === "pat-0777") continue;
        out.set(s.subjectId, {
          outcome: "OVERDUE",
          evidence: { official: { populationResults: [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }] } },
        } as never);
      }
      return out as never;
    },
    async evaluate() {
      throw new Error("no single-subject fallback in this stub");
    },
  };
  const subjects = Array.from({ length: 1200 }, (_, i) => ({ subjectId: `pat-${String(i + 1).padStart(4, "0")}`, bundle: {} }));
  const report = await gateMeasure("cms137", subjects, "2026-06-30", {
    executor,
    madie: async () => ({ pass: 45, fail: 0, total: 45 }),
    loadArtifact: () => null,
    chunkSize: 500,
  });
  assert.deepEqual(batches, [500, 500, 200]);
  assert.equal(report.roster.subjects, 1200);
  assert.equal(report.roster.inIpp, 1199);
  assert.equal(report.roster.evaluationErrors, 1);
});

test("the report carries the roster's provenance and the renderer prints it", async () => {
  const executor: BatchAndSingle = {
    async evaluateBatch(_measureId, subjects) {
      const out = new Map<string, never>();
      for (const s of subjects) {
        out.set(s.subjectId, {
          outcome: "OVERDUE",
          evidence: { official: { populationResults: [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }] } },
        } as never);
      }
      return out as never;
    },
    async evaluate() {
      throw new Error("no single-subject fallback in this stub");
    },
  };
  const source = { profile: "maui", directorySize: 20000, evaluated: 2000, routedAs: "cms122,cms125,cms137" };
  const report = await gateMeasure(
    "cms137",
    [{ subjectId: "pat-001", bundle: {} }],
    "2026-06-30",
    {
      executor,
      madie: async () => ({ pass: 45, fail: 0, total: 45 }),
      loadArtifact: () => ({ manifest: { catalogId: "cms137", effectivePeriod: { start: "2026-01-01", end: "2026-12-31" } } }) as never,
      rosterSource: source,
    },
  );
  assert.deepEqual(report.roster.source, source);
  const rendered = renderGate(report);
  assert.match(rendered, /profile=maui/);
  assert.match(rendered, /directory=20000/);
  assert.match(rendered, /evaluated=2000/);
  assert.match(rendered, /routed as WORKWELL_OFFICIAL_MEASURES=cms122,cms125,cms137/);
});
