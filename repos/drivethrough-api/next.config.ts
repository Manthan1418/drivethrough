import type { NextConfig } from 'next';

// Backend Next config — route handlers only, no pages. Cron schedule and function
// maxDuration belong in vercel.json (tech.md §1), not here. Keep this minimal;
// everything real lives under src/server/**.
const nextConfig: NextConfig = {};

export default nextConfig;
