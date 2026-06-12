/**
 * Storage contract — `OutcomeStore` (#104). Per-subject evaluated results for a run.
 * Mirrors the shape of the Postgres `outcomes` table (docs/DATA_MODEL.md), reduced
 * to what the run→evaluate→persist slice needs. Each backend adapter implements it;
 * application code never sees SQL. Canonical schema/migrations stay Taleef-owned.
 */
export interface RecordOutcomeInput {
  runId: string;
  subjectId: string;
  measureId: string;
  /** Bucket from the CQL `Outcome Status` define. */
  status: string;
  /** Define-level evidence (`evidence_json` contract, ADR-002). */
  evidence: unknown;
}

export interface OutcomeRecord {
  id: string;
  runId: string;
  subjectId: string;
  measureId: string;
  status: string;
  evidence: unknown;
  evaluatedAt: string;
}

export interface OutcomeStore {
  recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord>;
  listOutcomes(runId: string): Promise<OutcomeRecord[]>;
}
