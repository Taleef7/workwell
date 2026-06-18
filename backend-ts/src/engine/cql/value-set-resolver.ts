/**
 * Value-set expansion seam (#90 / E3.2). A pluggable resolver turns a value-set URL into its member
 * codes; `buildCodeService` assembles a populated `cql.CodeService` so a CQL value-set retrieve
 * (`[Procedure: "X"]`) filters by real membership instead of the inline-code workaround. The local
 * `StoreValueSetResolver` reads the existing ValueSetStore; a live VSAC adapter is a future drop-in
 * behind the same port (no engine change).
 */
// eslint-disable-next-line import/no-unresolved
import cql from "cql-execution";
import type { ValueSetStore, ValueSetRecord } from "../../stores/value-set-store.ts";

export interface CqlCode {
  code: string;
  system: string;
}

export interface ValueSetResolver {
  expand(valueSetUrl: string): Promise<CqlCode[]>;
}

export class StoreValueSetResolver implements ValueSetResolver {
  constructor(private readonly store: ValueSetStore) {}

  /** Request-scoped cache: one `listAll()` per resolver, reused across multiple `expand()` calls. */
  private all: Promise<ValueSetRecord[]> | null = null;

  async expand(valueSetUrl: string): Promise<CqlCode[]> {
    this.all ??= this.store.listAll();
    const vs = (await this.all).find((v) => v.oid === valueSetUrl || v.canonicalUrl === valueSetUrl);
    return vs ? vs.codes.map((c) => ({ code: c.code, system: c.system })) : [];
  }
}

export async function buildCodeService(resolver: ValueSetResolver, valueSetUrls: string[]): Promise<unknown> {
  // An unknown/unresolved URL expands to [] → an empty ValueSet (findValueSet returns it, not null),
  // so a retrieve against it matches nothing (correct CQL semantics) rather than erroring.
  const json: Record<string, Record<string, CqlCode[]>> = {};
  for (const url of valueSetUrls) {
    json[url] = { "1": await resolver.expand(url) };
  }
  return new cql.CodeService(json);
}
