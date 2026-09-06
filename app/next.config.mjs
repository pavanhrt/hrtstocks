import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app has its own package-lock.json, but stock-platform/package.json
  // (the seed/rule-engine tooling one level up) also has one -- pin the
  // tracing root here so Next doesn't guess between them.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
