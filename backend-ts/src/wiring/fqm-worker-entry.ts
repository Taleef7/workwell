/**
 * The worker thread the official calculation runs in (#604). See `fqm-worker.ts` for why.
 *
 * It runs `calculateOfficialWithSignal` whole, not the raw `fqm-execution` call: that function already
 * reduces fqm's raw output (which carries every resource each patient's retrieves touched), and running
 * it here means the raw output never has to cross back to the main thread.
 */
import { parentPort } from "node:worker_threads";
import { calculateOfficialWithSignal, type FqmCalculate, type OfficialCalculationInput } from "@work-well/official-executor";
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
    response = { id: request.id, ok: true, bySubject: [...bySubject], retrieveSignal };
  } catch (err) {
    const error = err as Error;
    response = { id: request.id, ok: false, message: String(error?.message ?? err), stack: error?.stack };
  }
  parentPort!.postMessage(response);
});
