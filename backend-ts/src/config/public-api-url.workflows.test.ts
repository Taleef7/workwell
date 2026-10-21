/**
 * `WORKWELL_PUBLIC_API_URL` on every stack (#704). Each deploy and its self-heal reconciler must set the same
 * value, it must pass the app's own validation, and it must be the API URL that stack's frontend is built
 * against (`BACKEND_TS_URL`): an MCP token's audience is built from it, so a reconciler that set a different
 * value, or none, would make every token minted before the self-heal invalid, or turn MCP off.
 *   node --import tsx --test src/config/public-api-url.workflows.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publicApiUrl } from "./public-api-url.ts";

const workflow = (name: string): string | null => {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url));
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const publicUrlOf = (yaml: string): string | undefined =>
  yaml.match(/\{key: "WORKWELL_PUBLIC_API_URL", value: "([^"]+)"\}/)?.[1];

const STACKS = [
  { deploy: "deploy-twh-mieweb.yml", reconcile: "reconcile-twh-mieweb.yml" },
  { deploy: "deploy-maui-mieweb.yml", reconcile: "reconcile-maui-mieweb.yml" },
  { deploy: "deploy-staging-mieweb.yml", reconcile: null },
];

test("every stack sets WORKWELL_PUBLIC_API_URL to its own API URL, the same in the deploy and the reconciler", () => {
  for (const stack of STACKS) {
    const deploy = workflow(stack.deploy);
    assert.ok(deploy, `${stack.deploy} exists`);
    const value = publicUrlOf(deploy!);
    assert.ok(value, `${stack.deploy} sets WORKWELL_PUBLIC_API_URL`);
    assert.equal(value, deploy!.match(/^\s*BACKEND_TS_URL: (\S+)$/m)?.[1], `${stack.deploy}: the frontend's API URL`);
    assert.deepEqual(publicApiUrl({ WORKWELL_PUBLIC_API_URL: value }, new Request("http://x/"), true), { ok: true, origin: value });
    if (stack.reconcile) {
      const reconcile = workflow(stack.reconcile);
      assert.ok(reconcile, `${stack.reconcile} exists`);
      assert.equal(publicUrlOf(reconcile!), value, `${stack.reconcile} mirrors ${stack.deploy}`);
    }
  }
});
