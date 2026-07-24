/**
 * Value-set expansion seam (#90 / E3.2). A pluggable resolver turns a value-set URL into its member
 * codes; `buildCodeService` assembles a populated `cql.CodeService` so a CQL value-set retrieve
 * (`[Procedure: "X"]`) filters by real membership instead of the inline-code workaround. The local
 * `StoreValueSetResolver` reads any `ValueSetSource`; a live VSAC adapter is a drop-in behind the
 * same port (no engine change).
 */
// eslint-disable-next-line import/no-unresolved
import cql from "cql-execution";

export interface CqlCode {
  code: string;
  system: string;
}

/** One value set as the engine consumes it — oid/canonical identity + member codes. */
export interface ValueSetSourceRecord {
  oid: string;
  canonicalUrl: string;
  codes: CqlCode[];
}

/**
 * The minimal read surface the engine needs from a value-set registry — deliberately NOT the app's
 * full `ValueSetStore` governance interface (30+ methods, of which the engine only ever called
 * `listAll()`). The app's store satisfies this structurally (its `ValueSetRecord` is a superset of
 * `ValueSetSourceRecord`), so nothing changes at call sites — but the engine no longer imports the
 * store layer, keeping `src/engine/` publishable as a standalone package (engine-boundary arch test;
 * extraction plan PR-1).
 */
export interface ValueSetSource {
  listAll(): Promise<ValueSetSourceRecord[]>;
}

export interface ValueSetResolver {
  expand(valueSetUrl: string): Promise<CqlCode[]>;
}

export class StoreValueSetResolver implements ValueSetResolver {
  constructor(private readonly store: ValueSetSource) {}

  /** Request-scoped cache: one `listAll()` per resolver, reused across multiple `expand()` calls. */
  private all: Promise<ValueSetSourceRecord[]> | null = null;

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
  const expanded = await Promise.all(valueSetUrls.map(async (url) => [url, await resolver.expand(url)] as const));
  for (const [url, codes] of expanded) {
    json[url] = { "1": codes };
  }
  return new cql.CodeService(json);
}
