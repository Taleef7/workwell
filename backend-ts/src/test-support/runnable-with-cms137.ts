/**
 * Test-only prelude (#889): lists retired cms137 back among this process's runnable measures.
 *
 * CMS137 is the one multi-rate measure, retired on the Maui profile, and its code paths stay live. A test
 * that exercises them imports this module FIRST (before anything that reads the runnable list at load),
 * so a child script's static imports see the override: modules evaluate in import order.
 */
import { __setRunnableMeasureIdsForTest, RUNNABLE_MEASURE_IDS } from "../config/deployment-profile.ts";

if (!RUNNABLE_MEASURE_IDS.includes("cms137")) __setRunnableMeasureIdsForTest([...RUNNABLE_MEASURE_IDS, "cms137"]);
