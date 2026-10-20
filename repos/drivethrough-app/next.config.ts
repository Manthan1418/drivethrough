import path from 'node:path';
import type { NextConfig } from 'next';

// Frontend Next config — intentionally minimal; the UI is meant to be re-altered
// later (owner requirement), so keep build knobs boring and local to this package.
// Network calls to the backend go through src/client/api.ts only.
const nextConfig: NextConfig = {
  // monorepo: pin the tracing root to the repo root (where package-lock.json lives),
  // so Next doesn't guess from stray lockfiles in ancestor dirs (local machines) or
  // mis-trace on Vercel with Root Directory set.
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
};

export default nextConfig;
