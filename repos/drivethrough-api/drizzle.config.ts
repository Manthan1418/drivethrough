// drizzle-kit — generates SQL migrations from schema.ts and applies them to Neon.
//   npm run db:generate   → writes SQL files to ./drizzle/
//   npm run db:migrate    → applies them to DATABASE_URL (from .env)
// drizzle-kit loads .env from the repo root automatically; if your run doesn't,
// prefix the command with:  node --env-file=.env ./node_modules/drizzle-kit/bin.cjs
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
