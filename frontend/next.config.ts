import type { NextConfig } from "next";

const isProductionBuild = process.env.NODE_ENV === "production";
const demoModeEnabled = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

if (isProductionBuild && demoModeEnabled) {
  throw new Error("Unsafe WorkWell configuration: NEXT_PUBLIC_DEMO_MODE=true is not allowed in production builds.");
}

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
