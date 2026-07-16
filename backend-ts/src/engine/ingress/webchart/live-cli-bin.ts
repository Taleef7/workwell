/** Entry point for `pnpm evaluate:webchart-live` (kept side-effect-free in `live-cli.ts` for tests). */
import { runLiveCli } from "./live-cli.ts";

process.exitCode = await runLiveCli(process.argv.slice(2));
