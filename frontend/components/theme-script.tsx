/**
 * Pre-hydration theme/brand bootstrap. Rendered as the first child of <body> in
 * the root layout so it runs synchronously BEFORE first paint — returning
 * dark-mode (or non-default-brand) users never see a light/default flash.
 *
 * Mirrors `lib/useTheme.ts` + `lib/useBrand.ts` (storage keys, brand list,
 * default brand). Keep these in sync if those change. The hooks remain the
 * source of truth for subsequent (runtime) theme/brand changes.
 */
const THEME_KEY = "workwell-theme";
const BRAND_KEY = "workwell-brand";
const DEFAULT_BRAND = "enterprise-health";
const BRANDS = ["enterprise-health", "mieweb", "bluehive", "webchart", "ozwell", "waggleline"];

const script = `(function(){try{
var d=document.documentElement;
var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});
if(t!=="light"&&t!=="dark"){t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";}
d.setAttribute("data-theme",t);
if(t==="dark"){d.classList.add("dark");}else{d.classList.remove("dark");}
var b=localStorage.getItem(${JSON.stringify(BRAND_KEY)});
var brands=${JSON.stringify(BRANDS)};
if(b&&brands.indexOf(b)!==-1){d.setAttribute("data-brand",b);if(b!==${JSON.stringify(DEFAULT_BRAND)}){var l=document.createElement("link");l.id="mieweb-brand-css";l.rel="stylesheet";l.href="/brands/"+b+".css";document.head.appendChild(l);}}
}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />;
}
