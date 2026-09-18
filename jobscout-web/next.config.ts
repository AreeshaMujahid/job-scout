import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // CVs are PDFs with embedded fonts and the odd headshot. The 1 MB
      // default rejects a good number of real ones.
      bodySizeLimit: "8mb",
    },
  },
  // Self-contained server bundle, so the Docker image can be a runtime plus
  // .next/standalone rather than the whole node_modules tree.
  output: "standalone",
  // PGlite ships a WASM build of Postgres. Bundling it into the server build
  // breaks the .wasm/.data file resolution, so it stays a runtime require.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
