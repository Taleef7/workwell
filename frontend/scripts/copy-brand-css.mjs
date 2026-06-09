// Copies @mieweb/ui brand CSS files into public/brands so they're served at
// /brands/{name}.css for runtime brand switching. Run via `pnpm sync:brands`
// after upgrading @mieweb/ui. Cross-platform (no shell `cp`).
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "node_modules", "@mieweb", "ui", "dist", "brands");
const dest = join(here, "..", "public", "brands");

if (!existsSync(src)) {
  console.error(`[copy-brand-css] source not found: ${src} — is @mieweb/ui installed?`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith(".css"));
for (const f of files) copyFileSync(join(src, f), join(dest, f));
console.log(`[copy-brand-css] copied ${files.length} brand CSS file(s) to public/brands`);
