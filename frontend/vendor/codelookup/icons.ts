/**
 * VENDORING SHIM — the upstream component imports these from `../Icons`, which is just
 * @mieweb/ui's re-export of lucide-react (already a direct dependency here, no new dep).
 * Mapping mirrors mieweb/ui `src/components/Icons/index.ts` exactly.
 */
export {
  Search as SearchIcon,
  Loader2 as LoaderIcon,
  AlertCircle as AlertCircleIcon,
  ChevronRight as ChevronRightIcon,
  ChevronLeft as ChevronLeftIcon,
} from "lucide-react";
