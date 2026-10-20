# DriveThrough — build workspace (monorepo)

**One git repo** (`github.com/Manthan1418/drivethrough`, owner decision 2026-10-20): spec docs at the root, code packages under `repos/`, npm workspaces in the root `package.json`. Deployed as **two Vercel projects**, each with its Root Directory pointed at a package.

| Package | Role | Vercel project |
|---|---|---|
| `repos/drivethrough-contracts` | Shared wire types (Zod + error codes). Public, no secrets. Built to `dist/` by the root `postinstall`. | — (npm workspace) |
| `repos/drivethrough-api` | Backend: route handlers only, DB, providers, upload/download engines, cron. | `drivethrough-api` → Root Directory `repos/drivethrough-api` |
| `repos/drivethrough-app` | Frontend: pages + components. No SQL/SDK/secrets. | `drivethrough-app` → Root Directory `repos/drivethrough-app` |

**Dependency rule (design.md §2.3):** `app` → `contracts` ← `api`. Neither app imports the other. Frontend re-alterability is a requirement (owner, 2026-10-20): keep `app/src/client/api.ts` the only network choke-point and `contracts` the only shared surface.

## Status
See `BUILD-STATUS.md` for what's done and what's blocked on account setup.

## Before first run
1. `npm install` **at the repo root** — one install for all three workspaces; its `postinstall` also builds `contracts` → `dist/`. (Prompts for approval per opencode.jsonc.)
2. Env files: `repos/*/.env.example` → `.env` in each package, filled from the console steps in `BUILD-STATUS.md`. (The app's `.env` and the api's `.env` are already filled — both are gitignored.)
3. Run: `npm run dev:app` → frontend on `:3000` · `npm run dev:api` → backend on `:3001`.

## Vercel setup (owner, at deploy time)
Create **two projects** from this one repo → Settings → General → **Root Directory** → `repos/drivethrough-app` / `repos/drivethrough-api`. Paste each package's env vars into the matching project (values live in each package's local `.env`). Set **Functions region = `sin1`** (Singapore) — Neon is `ap-southeast-1`.
