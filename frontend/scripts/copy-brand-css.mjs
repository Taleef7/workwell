// Copies @mieweb/ui brand CSS files into public/brands so they're served at
// /brands/{name}.css for runtime brand switching. Run via `pnpm sync:brands`
// after upgrading @mieweb/ui. Cross-platform (no shell `cp`).
//
// Self-hosted fonts (#453): a brand css that `@import`s Google Fonts makes every
// brand switch fetch from fonts.googleapis.com at runtime (and, inlined into
// globals.css, put a Google URL in the built bundle). Known imports are rewritten
// below to @font-face rules over committed files in public/fonts/ — the same
// variable woff2s Google served for that import (latin + latin-ext subsets,
// fetched 2026-08-12). An UNKNOWN Google Fonts import fails the copy loudly:
// silently shipping a new external fetch is the outcome this script exists to
// prevent, and the fix (extend SELF_HOSTED_IMPORTS + commit the woff2s) is cheap.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "node_modules", "@mieweb", "ui", "dist", "brands");
const dest = join(here, "..", "public", "brands");

const JOST_FONT_FACES = `/* Jost — self-hosted (#453); replaces the Google Fonts @import.
   Variable woff2s from css2?family=Jost:ital,wght@0,100..900;1,100..900 (latin + latin-ext). */
@font-face {
  font-family: 'Jost';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/jost-normal-latin-ext.woff2') format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Jost';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/jost-normal-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Jost';
  font-style: italic;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/jost-italic-latin-ext.woff2') format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Jost';
  font-style: italic;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/jost-italic-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}`;

// Exact @import URL (as it appears in the brand css) → replacement CSS.
const SELF_HOSTED_IMPORTS = new Map([
  [
    "https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,100..900;1,100..900&display=swap",
    JOST_FONT_FACES,
  ],
]);

const GOOGLE_IMPORT_RE = /^\s*@import\s+url\(\s*['"]?(https:\/\/fonts\.googleapis\.com\/[^'")]+)['"]?\s*\)\s*;\s*$/;

function selfHostFontImports(css, file) {
  return css
    .split("\n")
    .map((line) => {
      const m = line.match(GOOGLE_IMPORT_RE);
      if (!m) return line;
      const replacement = SELF_HOSTED_IMPORTS.get(m[1]);
      if (replacement === undefined) {
        console.error(
          `[copy-brand-css] ${file}: unknown Google Fonts import — self-host it (extend SELF_HOSTED_IMPORTS and commit the woff2s to public/fonts/):\n  ${m[1]}`,
        );
        process.exit(1);
      }
      return replacement;
    })
    .join("\n");
}

if (!existsSync(src)) {
  console.error(`[copy-brand-css] source not found: ${src} — is @mieweb/ui installed?`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith(".css"));
for (const f of files) {
  const css = readFileSync(join(src, f), "utf8");
  writeFileSync(join(dest, f), selfHostFontImports(css, f));
}
console.log(`[copy-brand-css] copied ${files.length} brand CSS file(s) to public/brands`);
