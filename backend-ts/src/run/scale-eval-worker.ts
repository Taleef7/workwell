/**
 * Worker-thread entry for the scale batch evaluator (#256). Runs ONLY inside a `node:worker_threads`
 * Worker spawned by `batch-evaluate-scale.ts` (the batch CLI path) — never on the request path.
 *
 * Startup (once per worker): read `workerData` config + reconstruct the `ScaleSubjectGenerator` from
 * its `kind` string. The FIRST evaluation lazily builds the shared `CqlExecutionEngine` (loading
 * ELM/FHIRHelpers once), so every subsequent subject in this thread reuses it.
 *
 * Per chunk message `(start, end)`: regenerate each subject's bundle IN-THREAD from its index (the
 * generator is deterministic on subject index — the killer property that lets work units be integer
 * ranges), evaluate every measure, and post back plain-JSON outcome rows. The evaluation itself reuses
 * the SAME pure `evaluateScaleSubjectMeasure` the sequential path calls, so a worker row is
 * byte-identical to the sequential row for the same (subject, measure) — the parity guarantee.
 */
import { parentPort, workerData } from "node:worker_threads";
import { targetForIndex, reconstructGenerator } from "./scale-generator.ts";
import { evaluateScaleSubjectMeasure, subjectIdForIndex } from "./batch-evaluate-scale.ts";
import type { ChunkRequest, ChunkResponse, WorkerOutcomeRow } from "./scale-eval-pool.ts";

interface ScaleWorkerData {
  asOf: string;
  totalSubjects: number;
  measureIds: string[];
  generatorKind: string;
  trimEvidence: boolean;
  rateByMeasure: Record<string, number>;
}

const data = workerData as ScaleWorkerData;
const generator = reconstructGenerator(data.generatorKind);
const port = parentPort;
if (!port) throw new Error("scale-eval-worker must run as a worker thread (no parentPort)");

port.on("message", (req: ChunkRequest) => {
  void (async () => {
    const rows: WorkerOutcomeRow[] = [];
    for (let i = req.start; i < req.end; i++) {
      const subjectId = subjectIdForIndex(i);
      for (const measureId of data.measureIds) {
        const target = targetForIndex(i, data.totalSubjects, data.rateByMeasure[measureId]!);
        const { status, evidence } = await evaluateScaleSubjectMeasure(
          generator,
          subjectId,
          measureId,
          target,
          data.asOf,
          data.trimEvidence,
        );
        rows.push({ subjectId, measureId, status, evidence });
      }
    }
    const res: ChunkResponse = { chunkId: req.chunkId, rows };
    port.postMessage(res);
  })();
});
