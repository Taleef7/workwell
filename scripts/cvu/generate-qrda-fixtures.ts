#!/usr/bin/env -S node --import tsx
/**
 * Generate synthetic, official-measure QRDA fixtures for the Cypress CVU+ rehearsal.
 *
 * This is a deliberately offline helper: it calls WorkWell's existing ADR-038 corpus generator,
 * runs the vendored CMS122/CMS125 artifacts through the official executor, and hands those results to
 * the existing QRDA I and QRDA III exporters. It is not wired into CI and does not start a server or
 * require Docker. Per-subject failures are recorded and skipped so a missing local terminology sidecar
 * or another fixture problem leaves useful evidence instead of aborting the whole sweep.
 *
 * Usage from the repository root:
 *
 *   pnpm --dir backend-ts exec tsx ../scripts/cvu/generate-qrda-fixtures.ts [output-directory]
 *
 * The default output is `cvu-workdir/documents/`. The directory is scratch-only and gitignored.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { MeasureOutcome } from "../../backend-ts/src/engine/evaluate-measure.ts";
import type { TargetOutcome } from "../../backend-ts/src/engine/synthetic/exam-config.ts";
import { directSyntheticGenerator } from "../../backend-ts/src/run/scale-generator.ts";
import { buildQrda1Document } from "../../backend-ts/src/fhir/qrda1-export.ts";
import { buildQrda3Document } from "../../backend-ts/src/fhir/qrda3-export.ts";
import type { OutcomeRecord } from "../../backend-ts/src/stores/outcome-store.ts";
import type { RunRecord } from "../../backend-ts/src/stores/run-store.ts";
import {
  officialMeasureExecutor,
  officialMeasurementPeriod,
} from "../../backend-ts/src/wiring/official-executor-adapter.ts";
import { loadOfficialArtifact } from "../../backend-ts/src/wiring/official-artifacts.ts";
import { officialTerminologyExpander } from "../../backend-ts/src/wiring/official-terminology.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUTPUT_DIRECTORY = path.join(REPO_ROOT, "cvu-workdir", "documents");
const EVALUATION_DATE = "2024-06-01";
const MEASURES = ["cms122", "cms125"] as const;
const TARGETS: readonly TargetOutcome[] = [
  "COMPLIANT",
  "DUE_SOON",
  "OVERDUE",
  "MISSING_DATA",
  "EXCLUDED",
];

interface DocumentManifest {
  kind: "qrda1" | "qrda3";
  file: string;
  measureId: string;
  target?: TargetOutcome;
  subjectId?: string;
  outcomeStatus?: string;
  officialInitialPopulation?: boolean;
  byteLength: number;
  wellFormednessFinding: string | null;
}

interface FixtureManifest {
  generatedAt: string;
  evaluationDate: string;
  documents: DocumentManifest[];
  failures: Array<{ measureId: string; target?: TargetOutcome; subjectId?: string; stage: string; error: string }>;
}

/**
 * Dependency-free XML check used for the manifest. The exporters are hand-built and intentionally have
 * no XML runtime dependency, so this checks nesting and escaped text/attributes at fixture time too.
 */
function xmlProblem(xml: string): string | null {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = tag.exec(xml)) !== null) {
    const text = xml.slice(lastEnd, match.index);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) return `unescaped & in text near ${text.slice(0, 40)}`;
    lastEnd = tag.lastIndex;
    const [, closing, name, attrs, selfClosing] = match;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(attrs ?? "")) return `unescaped & in attributes of <${name}>`;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? "nothing"}>`;
    } else if (!selfClosing) {
      stack.push(name!);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function runFor(measureId: string, period: { start: string; end: string }): RunRecord {
  return {
    id: `cvu-fixtures-${measureId}`,
    status: "COMPLETED",
    scopeType: "MEASURE",
    scopeId: measureId,
    triggeredBy: "script:cvu-fixtures",
    site: null,
    requestedScope: { measureId },
    startedAt: `${EVALUATION_DATE}T00:00:00.000Z`,
    completedAt: `${EVALUATION_DATE}T00:00:00.000Z`,
    measurementPeriodStart: `${period.start}T00:00:00.000Z`,
    measurementPeriodEnd: `${period.end}T23:59:59.999Z`,
  };
}

function outcomeRecord(measureId: string, target: TargetOutcome, outcome: MeasureOutcome, run: RunRecord): OutcomeRecord {
  return {
    id: `cvu-${measureId}-${target.toLowerCase()}`,
    runId: run.id,
    subjectId: outcome.subjectId,
    measureId,
    evaluationPeriod: run.measurementPeriodEnd.slice(0, 10),
    status: outcome.outcome,
    evidence: outcome.evidence.official ? { official: outcome.evidence.official } : {},
    evaluatedAt: `${EVALUATION_DATE}T00:00:00.000Z`,
  };
}

function addDocument(
  outputDirectory: string,
  relativeFile: string,
  xml: string,
  details: Omit<DocumentManifest, "file" | "byteLength" | "wellFormednessFinding">,
  manifest: FixtureManifest,
): void {
  const file = path.join(outputDirectory, relativeFile);
  writeFileSync(file, xml, "utf8");
  manifest.documents.push({
    ...details,
    file: relativeFile,
    byteLength: Buffer.byteLength(xml, "utf8"),
    wellFormednessFinding: xmlProblem(xml),
  });
}

async function generate(outputDirectory: string): Promise<FixtureManifest> {
  mkdirSync(outputDirectory, { recursive: true });
  const manifest: FixtureManifest = {
    generatedAt: new Date().toISOString(),
    evaluationDate: EVALUATION_DATE,
    documents: [],
    failures: [],
  };
  const generator = directSyntheticGenerator();

  for (const measureId of MEASURES) {
    const period = officialMeasurementPeriod(measureId, EVALUATION_DATE);
    const run = runFor(measureId, period);
    const records: OutcomeRecord[] = [];
    const executor = officialMeasureExecutor({
      expand: officialTerminologyExpander(loadOfficialArtifact),
    });

    for (const target of TARGETS) {
      const subjectId = `cvu-${measureId}-${target}`;
      try {
        const bundle = generator.bundleFor(subjectId, measureId, target, EVALUATION_DATE);
        const evaluated = await executor.evaluate({
          measureId,
          patientBundle: bundle,
          evaluationDate: EVALUATION_DATE,
        });
        const record = outcomeRecord(measureId, target, evaluated, run);
        const relativeFile = `${measureId}-${target.toLowerCase()}-qrda1.xml`;
        addDocument(
          outputDirectory,
          relativeFile,
          buildQrda1Document(run, measureId, record, bundle),
          {
            kind: "qrda1",
            measureId,
            target,
            subjectId,
            outcomeStatus: evaluated.outcome,
            ...(evaluated.inInitialPopulation === undefined
              ? {}
              : { officialInitialPopulation: evaluated.inInitialPopulation }),
          },
          manifest,
        );
        records.push(record);
        console.log(
          `[cvu] generated ${relativeFile}: status=${evaluated.outcome} officialInitialPopulation=${String(
            evaluated.inInitialPopulation,
          )}`,
        );
      } catch (error) {
        const message = errorMessage(error);
        manifest.failures.push({ measureId, target, subjectId, stage: "official-evaluation-or-qrda1", error: message });
        console.error(`[cvu] skipped ${measureId}/${target} (${subjectId}): ${message}`);
      }
    }

    if (records.length === TARGETS.length) {
      try {
        const relativeFile = `${measureId}-qrda3.xml`;
        addDocument(
          outputDirectory,
          relativeFile,
          buildQrda3Document(run, measureId, records),
          { kind: "qrda3", measureId },
          manifest,
        );
        console.log(`[cvu] generated ${relativeFile} from ${records.length} official outcomes`);
      } catch (error) {
        const message = errorMessage(error);
        manifest.failures.push({ measureId, stage: "qrda3", error: message });
        console.error(`[cvu] skipped ${measureId} QRDA III: ${message}`);
      }
    } else {
      const message = `only ${records.length}/${TARGETS.length} subject outcomes were generated; QRDA III was not built`;
      manifest.failures.push({ measureId, stage: "qrda3", error: message });
      console.error(`[cvu] skipped ${measureId} QRDA III: ${message}`);
    }
  }

  writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

const outputDirectory = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : DEFAULT_OUTPUT_DIRECTORY;

generate(outputDirectory)
  .then((manifest) => {
    console.log(
      `[cvu] wrote ${manifest.documents.length} document(s), ${manifest.failures.length} failure(s), manifest=${path.join(
        outputDirectory,
        "manifest.json",
      )}`,
    );
  })
  .catch((error) => {
    console.error(`[cvu] fatal: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
