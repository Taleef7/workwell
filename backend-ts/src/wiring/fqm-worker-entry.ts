/**
 * The worker thread the official calculation runs in (#604). See `fqm-worker.ts` for why.
 *
 * It runs `calculateOfficialWithSignal` whole, not the raw `fqm-execution` call: that function already
 * reduces fqm's raw output (which carries every resource each patient's retrieves touched), and running
 * it here means the raw output never has to cross back to the main thread.
 */
import "../engine/utc.ts"; // first: pins the process to UTC before anything reads a date (#845)
import { parentPort } from "node:worker_threads";
import {
  calculateOfficialWithSignal,
  type FqmCalculate,
  type OfficialCalculationInput,
  type OfficialSubjectResult,
} from "@work-well/official-executor";
import type { WorkerRequest, WorkerResponse } from "./fqm-worker.ts";

// A test can name a calculator module on the request; in production the field is absent and the real,
// lazily imported fqm calculator is used.
const calculators = new Map<string, Promise<FqmCalculate>>();
const calculatorFrom = (moduleUrl: string): Promise<FqmCalculate> => {
  let pending = calculators.get(moduleUrl);
  if (!pending) {
    pending = import(moduleUrl).then((mod: { calculate: FqmCalculate }) => mod.calculate);
    calculators.set(moduleUrl, pending);
  }
  return pending;
};

parentPort!.on("message", async (request: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    const input: OfficialCalculationInput = {
      ...request.input,
      ...(request.calculatorModule ? { calculate: await calculatorFrom(request.calculatorModule) } : {}),
    };
    const { bySubject, retrieveSignal } = await calculateOfficialWithSignal(input);
    // Statement results stay on this side: nothing on the main thread reads them (the adapter persists
    // populations, rates, strata and the rendered define values), and on a 2027 translation they carry
    // FHIR objects that were cloned across for nothing.
    const reduced = [...bySubject].map(([subject, result]): [string, OfficialSubjectResult] => [subject, { ...result, statements: [] }]);
    response = { id: request.id, ok: true, bySubject: reduced, retrieveSignal };
  } catch (err) {
    const error = err as Error;
    response = { id: request.id, ok: false, message: String(error?.message ?? err), stack: error?.stack };
  }
  parentPort!.postMessage(response);
});
