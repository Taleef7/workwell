import localFont from "next/font/local";

// Self-hosted fonts (#453). `next/font/google` downloads font binaries at BUILD time,
// which made fonts.gstatic.com a hard build dependency: a Google-side 404 failed CI and,
// worse, the production deploy (`deploy-twh-mieweb.yml` builds the frontend on every push
// to main). The committed .woff2 files are the exact latin-subset variable fonts Google
// served for the configurations previously requested via next/font/google
// (fetched 2026-08-12):
//   geist-latin.woff2       — css2?family=Geist:wght@100..900            (latin block)
//   geist-mono-latin.woff2  — css2?family=Geist+Mono:wght@100..900       (latin block)
//   fraunces-latin.woff2    — css2?family=Fraunces:wght@600;700          (latin block;
//                             Google serves the same variable file for both weights)
// To update a font, re-fetch the css2 URL with a woff2-capable User-Agent and replace
// the file. Jost (runtime brand switcher) lives in public/fonts/ instead — see
// scripts/copy-brand-css.mjs.

export const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const fraunces = localFont({
  src: "./fonts/fraunces-latin.woff2",
  weight: "600 700",
  adjustFontFallback: "Times New Roman",
});
