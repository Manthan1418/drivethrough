import path from 'node:path';
import type { NextConfig } from 'next';

// Backend Next config — route handlers only, no pages. Cron schedule and function
// maxDuration belong in vercel.json (tech.md §1), not here. Keep this minimal;
// everything real lives under src/server/**.
const nextConfig: NextConfig = {
  // monorepo: pin the tracing root to the repo root (where package-lock.json lives) —
  // same rationale as drivethrough-app/next.config.ts.
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
};

export default nextConfig;
