/**
 * Value-set expansion seam (#90 / E3.2). A pluggable resolver turns a value-set URL into its member
 * codes; `buildCodeService` assembles a populated `cql.CodeService` so a CQL value-set retrieve
 * (`[Procedure: "X"]`) filters by real membership instead of the inline-code workaround. The local
 * `StoreValueSetResolver` reads the existing ValueSetStore; a live VSAC adapter is a future drop-in
 * behind the same port (no engine change).
 */
// eslint-disable-next-line import/no-unresolved
import cql from "cql-execution";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

export interface CqlCode {
  code: string;
  system: string;
}

export interface ValueSetResolver {
  expand(valueSetUrl: string): Promise<CqlCode[]>;
}

export class StoreValueSetResolver implements ValueSetResolver {
  constructor(private readonly store: ValueSetStore) {}

  async expand(valueSetUrl: string): Promise<CqlCode[]> {
    const all = await this.store.listAll();
    const vs = all.find((v) => v.oid === valueSetUrl || v.canonicalUrl === valueSetUrl);
    return vs ? vs.codes.map((c) => ({ code: c.code, system: c.system })) : [];
  }
}

export async function buildCodeService(resolver: ValueSetResolver, valueSetUrls: string[]): Promise<unknown> {
  const json: Record<string, Record<string, CqlCode[]>> = {};
  for (const url of valueSetUrls) {
    json[url] = { "1": await resolver.expand(url) };
  }
  return new cql.CodeService(json);
}
