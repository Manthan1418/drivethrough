import type { NextConfig } from 'next';

// Frontend Next config — intentionally minimal; the UI is meant to be re-altered
// later (owner requirement), so keep build knobs boring and local to this package.
// Network calls to the backend go through src/client/api.ts only.
const nextConfig: NextConfig = {};

export default nextConfig;
