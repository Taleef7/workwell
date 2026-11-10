/**
 * Preloaded by `runProfileChild(..., { now })` before any other module: the child's clock starts at
 * `WORKWELL_TEST_NOW` and keeps ticking, so a suite can run at an instant where the practice's date and
 * the UTC date differ (#882) without freezing the timers a run's own code reads.
 */
const now = process.env.WORKWELL_TEST_NOW;
if (now) {
  const RealDate = Date;
  const offset = RealDate.parse(now) - RealDate.now();
  if (!Number.isFinite(offset)) throw new Error(`WORKWELL_TEST_NOW is not an instant: ${now}`);
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}

export {};
