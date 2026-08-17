/**
 * The slice of OpenAPI 3.1 this reference page renders (ADR-068).
 *
 * Deliberately partial, and deliberately not shared with the backend: `backend-ts/src/openapi/spec.ts` is a
 * different package, and a hand-copied "full" OpenAPI type model would be a large surface nothing here
 * reads. Everything optional is optional because the renderer must degrade rather than crash on a document
 * shape it does not recognise.
 */
export interface Schema {
  /** 3.1 spells nullability as a union: `["string", "null"]`. */
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  $ref?: string;
  example?: unknown;
}

export interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
}

export interface Operation {
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema: Schema }> };
  responses?: Record<string, { description: string; content?: Record<string, { schema: Schema }> }>;
}

export interface OpenApiDoc {
  openapi?: string;
  info?: { title?: string; version?: string; summary?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

/** An operation plus where it lives, which the path item does not carry. */
export interface Endpoint {
  path: string;
  method: string;
  op: Operation;
}

export function endpointsOf(doc: OpenApiDoc): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method: method.toUpperCase(), op });
    }
  }
  return out;
}

/** Resolve one level of `#/components/schemas/X`. Returns the input unchanged when it is not a `$ref`. */
export function resolve(schema: Schema | undefined, doc: OpenApiDoc): Schema | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  return doc.components?.schemas?.[name];
}

/** `"string"`, or `"string | null"` for a 3.1 union — what a reader wants to see. */
export function typeLabel(schema: Schema | undefined): string {
  if (!schema) return "";
  if (schema.$ref) return schema.$ref.replace("#/components/schemas/", "");
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) return schema.enum ? "enum" : "any";
  const base = types.join(" | ");
  return schema.format ? `${base} (${schema.format})` : base;
}
