// @mieweb/cloud-os ships untyped .mjs (JSDoc only). A minimal typed ambient declaration for the one
// export the evidence-bucket seam uses (#167 / ADR-030) keeps this boundary strict-typed — the same
// pattern as engine/cql/cql-libs.d.ts for the cqframework libraries.
declare module "@mieweb/cloud-os" {
  import type { CloudBucket } from "@mieweb/cloud";

  export function createS3Bucket(cfg: {
    bucket: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
    createIfMissing?: boolean;
  }): Promise<CloudBucket>;
}
