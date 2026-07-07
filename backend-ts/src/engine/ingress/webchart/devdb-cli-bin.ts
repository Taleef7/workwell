#!/usr/bin/env -S node --import tsx
/** Entry for `pnpm evaluate:webchart-devdb` (#246, PR-3). The lib (`devdb-cli.ts`) stays side-effect-free
 * and import-safe for tests; this bin unconditionally runs it, mirroring the other CLI bins. */
import { main } from "./devdb-cli.ts";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
