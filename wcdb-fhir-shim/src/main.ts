/** main.ts — process entry: bind the real MariaDB pool and serve. */
import { configFromEnv, createDb } from "./db.ts";
import { createShimServer } from "./server.ts";

const cfg = configFromEnv();
const port = Number(process.env.SHIM_PORT ?? 8085);
const db = createDb(cfg);
const server = createShimServer({ db });

server.listen(port, () => {
  console.log(`wcdb-fhir-shim listening on :${port} (wcdb ${cfg.host}:${cfg.port}/${cfg.database})`);
  console.log(`  FHIR root: http://localhost:${port}/fhir  (point WORKWELL_WEBCHART_BASE_URL=http://localhost:${port})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      void db.end().finally(() => process.exit(0));
    });
  });
}
