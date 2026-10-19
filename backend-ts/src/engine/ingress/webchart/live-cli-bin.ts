/** Entry point for `pnpm evaluate:webchart-live` (kept side-effect-free in `live-cli.ts` for tests). */
import "../../utc.ts"; // first: pins the process to UTC before anything reads a date (#845)
import { runLiveCli } from "./live-cli.ts";

process.exitCode = await runLiveCli(process.argv.slice(2));
