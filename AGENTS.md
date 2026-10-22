---
name: DriveThrough Project
description: Orientation for the DriveThrough project (Vercel-hosted multi-drive storage gateway). Use for ANY task in this repo — which phase we're in, where the spec docs live, what conventions apply, and the gate rule that nothing gets built until the user approves the docs.
---

# DriveThrough — project orientation

**What this is:** a Vercel-hosted storage gateway that pools multiple Google Drive + S3-compatible accounts into one virtual drive, with auth, virtual folders, resumable uploads, sharing, and quota management. Inspired by github.com/zenhosta/9drive (Apache-2.0) but redesigned for serverless (see prd.md §2.4 for what we fix).

## The four spec docs (source of truth — read the one matching your task)

| Doc | Contains | Read when |
|---|---|---|
| `prd.md` | Research: 9Drive anatomy, platform constraints, competition, algorithms, P0/P1/P2 requirements, risks, open questions | Planning, feature scoping, "should we…?" questions |
| `flow.md` | System flows: control/write/read planes, upload state machine, job schedules, API surface, acceptance scenarios | Any feature touching upload/download/auth/jobs behavior |
| `tech.md` | Stack, repo structure, Postgres schema, API contracts, provider interface, spikes S1–S6, security, testing gates, build phases | Writing or reviewing any code-level decision |
| `design.md` | Architecture, placement/chunking/read mechanisms, UX/IA, design tokens, error→UX taxonomy, tradeoff log | UI work, architecture changes, review debates |

Rule of cross-referencing: docs link each other by section — follow links instead of guessing; if two docs conflict, `tech.md` wins for code questions, `design.md` for UX, `prd.md` for scope.

## Phase status (updated as we go)

**Current phase: P0.2 COMPLETE (2026-10-22) — Google provider file layer live E2E-green against the real Drive (8/8 contract tests, `npm run test:e2e` in drivethrough-api; upload proxy 4 MB chunks, Range download proxy, quota sync, provider primitives); next up is P0.3 (folders/files CRUD, uploader UI w/ resume, trash, search).** The four docs are approved by the owner; the build gate is open. Decisions locked during approval:
- **One monorepo** (`github.com/Manthan1418/drivethrough`, amended 2026-10-20 — supersedes the original separate-repos rule): docs at root + `repos/{drivethrough-api, drivethrough-app, drivethrough-contracts}`. Still **two separate Vercel deployments** via per-project Root Directory — deployment separation unchanged, only git hosting merged. Contracts shared as an npm workspace (`"*"`), never a git URL — tech.md §2.
- Firebase = sign-in only; cross-origin **bearer-token auth, no cookies**.
- Striping stays **P1** (owner's biggest file fits one account).
- Frontend will be re-altered later for ease → keep it loosely coupled (types-only contract import, `api.ts` single network choke-point, swappable tokens layer). Backend must never import from frontend.
- Everything must run within free tiers (prd.md §11).

Still pending from the owner (blocked until provided): account setups — Google Cloud (Drive API + OAuth), Firebase project, Vercel (2 projects), Neon. Until each exists, its spike/scaffold step uses placeholders and is marked TODO.

## Conventions (port of 9Drive's AGENTS.md, adapted)

- TypeScript strict; no `any` in provider/upload/download code paths.
- Route handlers: HTTP only (auth, validation, status codes) → use-case services in `server/**` → providers/db. No SQL or provider SDK calls directly in `src/app/api/**`.
- Never buffer a whole file: no `await req.text()/arrayBuffer()` in upload paths, no `Buffer.concat` of file bodies — stream (`duplex: 'half'`, `ReadableStream` piping). Guard test exists for this (tech.md §9).
- Errors: stable `{ code, message }` JSON; codes listed in flow.md §9 and design.md §6.
- Secrets: encrypted at rest via `server/crypto` vault (`TOKEN_ENCRYPTION_KEY`, AES-256-GCM); bearer-style secrets stored hashed. Never log tokens or credentialed URLs.
- Sharing is private-by-default, `reader`-only, expiring. Never emit `role: 'writer'` public permissions (9Drive bug we fix).
- Sizes are `bigint` in DB, strings in JSON.
- **ACID-for-files:** every write path must be atomic, non-blocking, idempotent, and limbo-free (guarantees G1–G9 — prd.md §5.4, mechanisms tech.md §3). If you can't state the guarantee for a change, it isn't mergeable.
- **No-cost rule:** v1 must run entirely within verified free tiers (prd.md §11). Never add a paid service, dependency, or plan upgrade in a change — if a free tier can't cover it, that's a design escalation (back to the user), not a commit.
- Schema changes only via migration files; add indexes for new hot-path filters.
- Verify with: `npx tsc --noEmit`, `npm run build`, unit tests (Vitest), and for UI-adjacent work the guard tests in tech.md §9.

## Built-in skills to load during build (already available in this harness)

- `ui-styling` / `refactoring-ui` / `better-ui` → when implementing design.md §5 screens and tokens
- `playwright-skill` (or `playwright-core`) → e2e scenarios from flow.md §10
- `gsap-scrolltrigger` only if adding marketing/landing motion (not core app)
- Load via the `skill` tool when the task matches; don't load them speculatively.

## Project skills installed in this repo

| ID | Use for |
|---|---|
| `vercel-limits` | Any decision about bodies, streaming, duration, cron, egress on Vercel |
| `storage-gateway` | Placement, reservations, quota invariants, striping, dedup, reconciliation |
| `resumable-upload` | Upload state machine, chunk protocol, resume/idempotency, session GC |
| `google-drive-api` | Drive OAuth, resumable handshake, quotas, Range downloads, permissions |
