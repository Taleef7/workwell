import type { NextConfig } from "next";

const isProductionBuild = process.env.NODE_ENV === "production";
const demoModeEnabled = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

if (isProductionBuild && demoModeEnabled) {
  throw new Error("Unsafe WorkWell configuration: NEXT_PUBLIC_DEMO_MODE=true is not allowed in production builds.");
}

const nextConfig: NextConfig = {
  output: "standalone",
  // The NITRO data grid (@mieweb/ui/datavis) imports raw TS/TSX from the vendored
  // `datavis` package (frontend/vendor/datavis). Next must transpile it like first-party
  // source, and must also transpile @mieweb/ui so its internal extensionless `datavis/src/*`
  // deep imports go through the project resolver (which appends .ts/.tsx).
  transpilePackages: ["datavis", "@mieweb/ui"],
  async redirects() {
    return [
      {
        source: "/programs/overview",
        destination: "/programs",
        permanent: false
      }
    ];
  }
};

export default nextConfig;
