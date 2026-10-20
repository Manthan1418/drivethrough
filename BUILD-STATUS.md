# Build status — updated as work proceeds

**Phase: P0.0 (spikes + schema port). Started 2026-10-20.**

## Done (no accounts required — pure file writing)
- **Docs aligned to two-repo decision** — tech.md §1/§2/§4/§7/§8, design.md §2.1/§2.3/§8, flow.md §1/§2/§9, AGENTS.md, vercel-limits skill. All "session cookie / monolith / one-deploy" references → cross-origin bearer.
- **`drivethrough-contracts`** — errors.ts (stable codes), uploads.ts (Zod upload protocol), domain.ts (FileMeta/Folder/Account/Share/ApiKey/etc.), accounts.ts (connect/list/sync contracts), index.ts barrel. package.json + tsconfig.
- **`drivethrough-api`** — DB schema ported to Drizzle (`src/server/db/schema.ts`, 15 tables, exact indexes, ACID conventions), provider interface (`providers/types.ts`, tech.md §5), crypto vault (`crypto/vault.ts` AES-256-GCM + hashing), errors (`errors.ts`), CORS (`cors.ts`), Firebase auth guard (`auth/verify.ts` + `db-user.ts` firebase_uid→users upsert), placement engine (`storage/placement.ts`). package.json, tsconfig, `.env.example`.
- **`drivethrough-app`** — package.json (+ Tailwind 4), tsconfig, `postcss.config.mjs`, `globals.css` (design.md §5.3 tokens), `src/client/api.ts` (single network choke-point, async token getter), `src/client/accounts.ts` (connect flow), `src/client/firebase.ts` (client init, env-missing guard), `src/client/auth-context.tsx` (AuthProvider: Google popup w/ redirect fallback, email/password sign-in+up, token → api.ts, sign-out drops token), pages: `layout.tsx` (mounts AuthProvider), `(auth)/sign-in` (Google + email/password, mode toggle, mapped auth errors), `page.tsx` (auth gate → hub), `settings` (OAuth landing + account cards: quota bar, sync, disconnect — design.md §5.6), `.env.example`.
- **Google OAuth connect flow (flow.md §3)** — `providers/google-oauth.ts` (consent URL, code exchange, refresh, root folder, quota — raw fetch), `accounts/connect-service.ts` (single-use state consume, token encrypt AAD-bound, account upsert, quota sync), routes: `GET /api/accounts`, `GET /api/accounts/google/start`, `GET /api/accounts/google/callback` (302 to frontend, no bearer), `POST /api/accounts/:id/sync-quota` (ownership checked first), `DELETE /api/accounts/:id` (soft disable). Frontend `connectGoogleAccount()` navigates the browser to Google.

## Blocked on owner account setup (needs you)
| Item | Blocks | What I need from you |
|---|---|---|
| Vercel account + 2 projects | S1, S2 deploys, everything | Create `drivethrough-api` + `drivethrough-app` projects; connect GitHub repos once pushed |
| Google Cloud project (Drive API + OAuth consent Testing) | S1 (Drive proxy test), connect-a-account flow | Enable Drive API; create OAuth client; add yourself as test user; share client ID/secret |
| Firebase project (Google + email/password) | ~~S5 / sign-in~~ **code is done** — sign-in UI, auth context, token bridge, backend guard all written | Create project → enable **Google** + **Email/Password** providers → add **Web app** → paste 4 `NEXT_PUBLIC_FIREBASE_*` into app `.env.local` → Service accounts → JSON into api `.env.local`; add your site origin to **Authorized JavaScript origins** (popup) |
| Neon (Postgres) | nothing — ✅ **string provided 2026-10-20** (in api `.env`, TLS-verified reachable; mirror to Vercel envs at deploy, function region `sin1` to match `ap-southeast-1`) | Step 6: `db:generate` + `db:migrate` (drizzle.config.ts now exists), then S4 burst test |

## Next up (in order, per tech.md §12)
1. Owner completes account setup (table above) → fills `.env.local` files.
2. ~~`git init` + push each repo~~ → **monorepo instead** (owner decision 2026-10-20): `git init` at the root, one push to `github.com/Manthan1418/drivethrough`; `<ORG>` git-deps removed (npm workspaces `"*"` + root `postinstall` builds contracts). Local commit done; **push waits on the owner registering an SSH public key with GitHub (one paste).**
3. Spike S2 (chunk streaming under Vercel) — self-contained, needs only Vercel.
4. Spike S1 variant A (Vercel Drive proxy) + variant B (free Worker relay) — needs Google + Vercel.
5. Spike S5 (cross-origin Firebase guard) — needs Firebase + both Vercel projects.
6. Migrate schema to Neon (`db:generate` + `db:migrate`).
7. Then P0.1 foundation (wiring services into route handlers).

## Decisions locked
- Two repos + shared contracts; bearer-only cross-origin auth; striping stays P1; free-tier-only (prd.md §11).
- Drizzle chosen over Prisma for the DB port (lighter, driver-adapter-friendly, matches R4/serverless). Swap to Prisma only if a spike demands it.
