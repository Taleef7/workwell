/**
 * Guard for cqframework/clinical_quality_language#1871 (#845): a resolved Condition with no abatement date
 * is never prevalent, under the QICoreCommon ELM every committed bundle ships, on the engine that scores
 * official measures.
 *
 * The shipped ELM has the translator bug: `abatementInterval`'s `else null` became an interval with closed
 * null bounds. cql-execution 3.3.2 still answers correctly, so this passes today. An engine that answers
 * spec-correctly for that ELM (cql-execution 4.0.0-beta.1 returns `[onset, 9999-12-31]`) fails it. That is
 * the point: upgrading the engine before the bundles are re-translated must not silently make every such
 * Condition prevalent forever. Needs no terminology: `prevalenceInterval` reads codes, not value sets.
 *
 *   node --import tsx --test src/standards/qicore-common-prevalence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCqlExecFhir } from "@work-well/official-executor";
import { PREVALENCE_CASES, bundleElm, prevalenceOn20260701 } from "../test-support/prevalence-harness.ts";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The cql-execution that fqm-execution itself loads: the engine that scores official measures. */
function officialEngine() {
  const fromPackage = createRequire(pathToFileURL(join(backendRoot, "packages/official-executor/src/index.ts")).href);
  return createRequire(fromPackage.resolve("fqm-execution"))("cql-execution");
}

function committedBundles(): string[] {
  const out: string[] = [];
  for (const kind of ["official", "derived"]) {
    const dir = join(backendRoot, "measures", kind);
    for (const id of readdirSync(dir)) {
      const path = join(dir, id, "bundle.json");
      if (existsSync(path)) out.push(`${kind}/${id}`);
    }
  }
  return out.sort();
}

test("#1871 guard: under every committed bundle's QICoreCommon, a resolved Condition with no abatement is never prevalent", async () => {
  const cql = officialEngine();
  const cqlfhir = await loadCqlExecFhir();
  const expected = Object.fromEntries(PREVALENCE_CASES.map((c) => [c.id, c.prevalentOn20260701]));

  // Bundles sharing one QICoreCommon ELM are evaluated once.
  const byElm = new Map<string, string[]>();
  const libraries = new Map<string, ReturnType<typeof bundleElm>>();
  for (const name of committedBundles()) {
    const elm = bundleElm(JSON.parse(readFileSync(join(backendRoot, "measures", name, "bundle.json"), "utf8")));
    const qcc = elm.get("QICoreCommon");
    if (!qcc) continue;
    const key = createHash("sha256").update(JSON.stringify(qcc)).digest("hex");
    byElm.set(key, [...(byElm.get(key) ?? []), name]);
    if (!libraries.has(key)) libraries.set(key, elm);
  }
  const covered = [...byElm.values()].flat();
  // Non-vacuity: the six ACO measures must be covered, CMS's artifacts and the 2027 translations alike.
  for (const m of ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"]) {
    assert.ok(covered.includes(`official/${m}`), `official/${m} must carry QICoreCommon`);
    assert.ok(covered.includes(`derived/${m}`), `derived/${m} must carry QICoreCommon`);
  }

  for (const [key, bundles] of byElm) {
    const actual = await prevalenceOn20260701(cql, cqlfhir, libraries.get(key)!);
    assert.deepEqual(actual, expected, `QICoreCommon as shipped in ${bundles.join(", ")}`);
  }
});
