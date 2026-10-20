# DriveThrough — Product Requirements & Research Document (PRD)

> **Status:** Research complete — build NOT started (per project rule: no implementation until research + docs are final)
> **Date:** 2026-10-20
> **Inspiration:** [github.com/zenhosta/9drive](https://github.com/zenhosta/9drive) (Apache-2.0, 2.6k ★, 483 forks)
> **Working title:** DriveThrough (placeholder — folder name; rename freely before build)

---

## 1. Executive Summary

**9Drive** is a self-hosted "storage gateway" web app that connects multiple Google Drive (and S3-compatible) accounts into one virtual storage dashboard: combined quota tracking, virtual folders, upload routing to the account with free space, preview/download/share, and API-key uploads. It runs as a long-lived Express + MySQL server you deploy on a VPS, Docker, or PM2.

**DriveThrough** is the same product idea rebuilt as a **cloud-native, Vercel-hosted service**: accessible from any device/browser behind my own authentication, zero servers to maintain, deployed with `git push`. The core engineering challenge is that Vercel's serverless model directly contradicts how 9Drive works today (long-running Node process, streaming multipart bodies, unbounded request/response payloads). This document captures the research done to resolve that tension, the product requirements that fall out of it, and the risks known before a single line of app code is written.

---

## 2. Inspiration Research: How 9Drive Works

### 2.1 Repository anatomy

| Area | Finding |
|---|---|
| Structure | `backend/` (Express API) + `frontend/` (Vite React) + Docker/VPS/PM2 deployment scripts |
| Backend stack | Express 5, TypeScript, Prisma 6, **MySQL**, Zod, JWT bearer auth, Argon2, Busboy multipart, `googleapis`, Undici |
| Frontend stack | React 19, Vite 8, React Router 7, Tailwind CSS 4, lucide-react |
| DB models | `User`, `Session`, `ConnectedAccount`, `StorageAccount`, `File`, `Folder`, `UploadSession`, `FileShare`, `PreviewToken`, `ApiKey`, `UploadRoutingPolicy`, `AuditLog`, `S3StorageConfig`, `WorkspaceInvite`, `ProviderConfig`, `OauthState`, `AuthHandoff` |
| Physical layout | Every file lands under one root Drive folder named `9drive`; **virtual folders live only in MySQL** (not mirrored to Drive) |
| Auth | Email/password + Google sign-in; Google OAuth client config stored **encrypted in DB**; app refresh tokens hashed; share/preview/handoff tokens hashed |
| License | Apache-2.0 (safe to build upon and proprietary-ize with attribution) |

### 2.2 Feature inventory (what it does today)

- Connect N Google Drive accounts + S3-compatible endpoints (MinIO, R2, Wasabi, B2, AWS S3)
- Multi-account quota summary + Quota Tracker page (sync per account)
- Upload with **routing policies**: `most_available`, `round_robin`, `priority` (per-user, persisted)
- External upload API (`POST /api/v1/uploads`) with API keys (hashed, one-time secret display, revocation)
- Resumable upload protocol already exists: `POST /uploads/resumable/init` → `PUT /uploads/resumable/chunk/:id` (Content-Range) → `GET /uploads/resumable/status/:id`, proxying to **Google's resumable session URI**
- Virtual nested folders, search, preview (image/video/PDF/text via preview tokens), download, rename, move, batch ops, trash
- Share links (public token), invites (viewer roles), activity/audit log
- Manual "Sync Drive" that treats the `9drive` Drive folder as source of truth (reconcile MySQL ↔ Drive)
- In-app API docs, upload progress panel, optional reCAPTCHA, PWA icons

### 2.3 What 9Drive does well (keep these ideas)

1. **Metadata/physical separation** — folders and hierarchy are app-level rows; providers only hold opaque blobs under one root. Makes provider swaps and multi-provider support trivial.
2. **Token hygiene** — refresh tokens, share tokens, preview tokens, OAuth states are all *hashed at rest*; provider tokens encrypted with `TOKEN_ENCRYPTION_KEY`.
3. **Upload sessions table** — durable record of every upload attempt with provider session URI, enabling resume after crash/network loss.
4. **Routing policy as data** — placement preference is a persisted per-user row, not hardcoded.
5. **Reserved-bytes accounting** — `selectAccount()` subtracts in-flight reservations so parallel uploads can't double-spend the same free space.
6. **Resumable chunk endpoint shape** — Content-Range based chunk proxy is exactly the primitive Vercel needs (see §4).

### 2.4 Limitations found (the reason this project exists)

| # | Limitation | Evidence |
|---|---|---|
| L1 | **Runs locally/on a VPS only** — Docker, PM2, `setup.sh`, an exposed MySQL, a reverse proxy. Not "open on my phone anywhere" out of the box. | README deployment sections |
| L2 | **Stateful server assumption** — Express holds the multipart stream; entire file is buffered into a `Buffer[]` → `Buffer.concat()` before upload (the "streams without touching disk" claim is true for *disk*, false for *memory*: a 5 GB upload would need 5 GB RAM). | `upload.routes.ts` non-resumable path |
| L3 | **Whole-file placement only** — a file must fit inside a *single* account or you get `NO_ACCOUNT_WITH_ENOUGH_SPACE`. No striping ⇒ you cannot actually use the *pool* for one big file. | `selectAccount()` |
| L4 | **In-process reservations** — `reservedBytesByAccount` is a local `Map` per request; correct only because one HTTP request owns the batch. Multi-process/multi-instance would race. | `upload.routes.ts` |
| L5 | **MySQL is not serverless-friendly** — no connection-per-function story without a proxy/adapter; schema is MySQL-specific (`Char(36)`, migrations). | `schema.prisma` |
| L6 | **Security flaw: every upload is made world-`writer`** — `permissions.create({role:'writer', type:'anyone'})` on both upload paths. Anyone with the link can *edit/delete* your files. | `upload.routes.ts` (both paths) |
| L7 | **Ops risk** — Settings UI triggers `update.sh` which runs `git reset --hard && git pull` on the host. | README "Automated Updates" |
| L8 | **No true durability story** — one copy in one account; if that Google account is disabled/banned, data is gone. No replication or parity. | architecture |
| L9 | **No deduplication** — same file uploaded twice costs 2× quota. | schema has `checksum` column but nothing consumes it |

**Requirement derived:** DriveThrough must solve L1 (host anywhere, Vercel), keep the good parts of §2.3, and fix L2–L9 as it migrates — at minimum L2, L3, L6, and L4.

---

## 3. Target Users & Jobs-To-Be-Done

**Primary user: the owner (you).** Single-tenant power user who:
- Holds files spread across several Google accounts (personal, alt, edu, old) + free-tier S3 buckets (R2/B2) and wants **one pool**.
- Wants to open `https://<app>.vercel.app` from a phone/laptop/office PC and see everything.
- Uploads multi-GB files (backups, videos, VM images) on flaky mobile networks ⇒ **resume matters**.
- Cares that a leaked share link can be revoked and expires.

**Secondary (P1):** trusted others via share links/invites (view-only by default).

**Non-goals for v1:** public multi-tenant SaaS, teams/permissions beyond viewer, replacing Drive's own UI for collaboration (no co-editing).

---

## 4. Platform Research: What Vercel Allows (constraints that shape the product)

Sources: [Vercel Functions Limits](https://vercel.com/docs/functions/limitations) (updated 2026-08), [How to upload and store files with Vercel](https://vercel.com/kb/guide/how-to-upload-and-store-files-with-vercel) (2026-09), [bypass 4.5MB KB](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions), [Vercel Plans](https://vercel.com/docs/plans/hobby).

| Constraint | Value | Consequence for DriveThrough |
|---|---|---|
| Request **body** limit | **4.5 MB** (413 `FUNCTION_PAYLOAD_TOO_LARGE`) | Cannot accept a whole file through a route handler. Uploads must be **chunked ≤ ~4 MB per request** or **direct-to-provider**. |
| Response **body** limit | **4.5 MB** *unless the response is streamed* — official KB: *"we recommend using streaming functions, which don't have this limit"* | Downloads/previews must be **streamed responses** (ReadableStream passthrough), never buffered JSON-style. |
| Max duration | Hobby **300s**; Pro 800s (1800s beta) | A function can proxy a large download for minutes, but a 50 GB transfer may outlive it ⇒ prefer **redirect to presigned/direct URL** for big reads. |
| Memory | Hobby 2 GB / Pro 4 GB | Reinforces "never buffer the file" (fixes L2 by platform pressure). |
| Bundle size | 250 MB uncompressed | Keep `googleapis`-heavy deps trimmed; use raw `fetch` against Drive REST where practical. |
| File descriptors | 1024 shared per instance | Use pooled HTTP agents; don't fan out hundreds of provider calls per invocation. |
| Region | Single region default (`iad1`); multi-region Pro+ | Choose region near the *accounts'* data centers' egress path; latency to Google APIs is unavoidable. |
| Background jobs | Vercel Cron / **Vercel Workflows** / Upstash QStash | Quota sync, reconciliation, trash purge run as cron/workflow tasks — no `setInterval` in a server. |
| Durable state | **Postgres (Neon / Vercel Postgres)** marketplace integrations; Prisma driver adapters | Replaces MySQL (fixes L5). |
| Blob (optional) | Vercel Blob: 5 TB max file, client-direct SDK, private stores GA (Feb 2026), $0.023/GB-mo | Optional 5th provider + optional staging buffer for very large uploads. |
| WebSockets | public beta on all plans | Not needed v1 (progress = client-side + polling). |

**Derived platform rules (non-negotiable in tech.md/design.md):**
- **R1** No request or non-streamed response > 4.5 MB anywhere.
- **R2** Files never fully enter function memory; always stream request→provider (chunk ≤ 4 MB) or bypass the function entirely (presigned/direct).
- **R3** Long transfers prefer **redirects** (client ↔ provider directly) over proxies; proxy only when the provider cannot issue a scoped URL (Google Drive).
- **R4** All background work is cron/workflow-based; the app must be correct with zero long-lived processes.

### 4.1 Google Drive API research (quotas & capabilities)

- **Upload allowance:** 750 GB per user per 24 h (consumer); hitting it blocks further uploads until reset ([usage limits](https://developers.google.com/workspace/drive/api/guides/limits)).
- **Query rate:** ~1,000 queries / 100 s / user; practical throttle guidance includes exponential backoff.
- **Resumable uploads:** `POST /upload/drive/v3/files?uploadType=resumable` returns a session `Location`; subsequent `PUT` with `Content-Range` returns **308 + `range` header** until final chunk → 200 with file metadata. Chunk size must be a multiple of 256 KB (except final). 9Drive already implements exactly this handshake.
- **Downloads:** `files.get?alt=media` supports `Range` headers (partial content) ⇒ streaming proxy with Range passthrough is viable for previews.
- **Sharing:** permission roles `reader` / `writer` / `commenter`; **v1 default must be `reader` or private** (fixes L6).
- **Browser-direct uploads:** Google's upload endpoints are usable from the browser with a bearer token (classic gapi/XHR pattern), but this **exposes the access token to the client** and needs a CORS validation spike. Design keeps it as an *optional* fast path behind a feature flag; default is chunked server proxy (safe), see tech.md §6.

### 4.2 Serverless database & auth research

- **DB:** Neon (or Vercel Postgres) + Prisma **driver adapters** (`@prisma/adapter-*`) or Drizzle over `postgres.js` HTTP/WS driver — both are the documented Vercel patterns; MySQL via PlanetScale is possible but off the natural path. Schema migration MySQL→Postgres needed (L5).
- **Auth (research):** 2026 consensus favors **Better Auth** as self-hosted default (notable signal — *Auth.js/NextAuth is now maintained by the Better Auth team*). **Decision for this project: Firebase Authentication** (owner's choice) — Google-native sign-in, no credential/session handling in our DB, generous free tier, zero auth UI to maintain. Tradeoff: identity store split across Firebase (who you are) + Postgres (what you own), and every protected route must verify Firebase ID tokens server-side (keyless JWT verification against Google's public keys — `firebase-admin` was dropped 2026-10-20 when org policy blocked service-account key creation). Better Auth remains the documented fallback if we ever need fully self-hosted identity.

### 4.3 Competitive landscape

| Product | Model | Gap DriveThrough fills |
|---|---|---|
| **9Drive** (inspiration) | Self-hosted gateway, whole-file placement | We keep its UX, fix serverless + striping + security |
| **9-in-1-Cloud** (GitHub fork-class) | Same idea, up to 9 accounts | Confirms demand; still self-hosted |
| **MultCloud / CloudMounter / oDrive** | SaaS/desktop multi-cloud managers | Closed source, subscription, no "my own pool" control; MultCloud transfers *between* clouds, weaker "one pool" story |
| **rclone** (union/chunker backends) | CLI, 50+ providers, chunker+union = split files across backends | Powerhouse but no web UI/auth/sharing; we adopt its *ideas* (chunker striping, union policies) for a browser product |
| **Dropbox-style designs** (public system-design literature) | CDC chunking + dedup + block-level sync | Validates FastCDC dedup as a P2 direction (see §6) |

---

## 5. Product Requirements

### 5.1 P0 — v1 must-have (the "it exists" bar)

**Auth & tenancy**
- P0-1 **Firebase Authentication**: Google popup + email/password handled by Firebase's client SDK; route handlers verify the ID token server-side and map `firebase_uid` → `users` row. Single-owner account with invite-only sharing. (Firebase = sign-in only; connecting Drive accounts stays a separate server-side OAuth flow.)
- P0-2 Every API route authenticated (session or API key); rate-limited auth endpoints.

**Provider connection**
- P0-3 Connect N Google Drive accounts (OAuth, offline refresh, tokens encrypted at rest).
- P0-4 Connect S3-compatible endpoints (R2/B2/Wasabi/MinIO/AWS): endpoint, region, bucket, keys, prefix.
- P0-5 Per-account health: last quota sync, last error, disconnect.

**Unified storage**
- P0-6 Combined quota dashboard: total/used/free across accounts, per-account bars, reserved (in-flight) bytes.
- P0-7 Virtual nested folders, file list/grid, rename, move, batch move/delete, search, starred, recent, trash + restore + auto-purge.
- P0-8 **Upload**: client slices file into **≤4 MB chunks** → resumable session → placement decision → chunk proxy to provider; progress panel; **resume after refresh/network drop**; parallel-safe reservations (DB-transaction based, fixes L4).
- P0-9 Placement policies: `most_available` (default), `round_robin`, `priority` — persisted per user (as 9Drive).
- P0-10 Download: **S3 → presigned redirect** (no function bandwidth), **Drive → streamed Range proxy**; preview for images/video(PDF/text) with short-lived hashed preview tokens.
- P0-11 Share links: hashed token, optional expiry, **default viewer-read-only**, revoke (fixes L6); public page renders preview + download.
- P0-12 API keys (hashed, prefix shown once, scopes, revoke, last-used) + `POST /api/v1/uploads` external upload using the same chunk protocol.
- P0-13 Background jobs (cron/workflow): quota sync (stale > 5 min triggers refresh), trash purge after N days, orphan reconciliation (DB ↔ provider listing, the "Sync Drive" idea automated).
- P0-14 Audit log of uploads/deletes/shares/key usage.
- P0-15 Deploy on Vercel with one click; env documented; no exposed database.

### 5.2 P1 — v1.x (the "better than 9Drive" bar)

- P1-1 **Chunk striping across accounts** — files larger than any single account's free space split into ordered chunks distributed over accounts (rclone-chunker-style), with a manifest row set in the DB. *Directly fixes L3 and delivers the true "combined storage" promise.*
- P1-2 Whole-file **dedup by SHA-256** (store once, reference many) with per-user scope.
- P1-3 Client-side E2E encryption option (zero-knowledge mode; provider sees ciphertext only).
- P1-4 Batch/folder upload queue with retry, pause/resume, offline queue (PWA).
- P1-5 Webhooks / CLI (`drivethrough put/get`) and rclone-compatible S3 gateway endpoint (stretch).
- P1-6 Versioning (keep previous file revisions), file details drawer with full provenance.
- P1-7 Two-factor auth, device/session management page.

### 5.3 P2 — future

- P2-1 **Erasure coding** (Reed–Solomon k+m across accounts) for durability against account loss (fixes L8) — CPU cost must be measured on serverless first.
- P2-2 **Content-defined chunking (FastCDC)** dedup + delta-friendly chunk sizes ([FastCDC paper](https://www.usenix.org/system/files/conference/atc16/at16-paper-xia.pdf)).
- P2-3 Direct browser→Drive fast path (token-scoped, feature-flagged after CORS/security spike).
- P2-4 Multi-provider: Dropbox, OneDrive, Storj, Tigris.
- P2-5 Mobile apps / share-target integration.

---

### 5.4 Cross-cutting guarantees — "ACID for files" (non-negotiable)

These apply to **every** P0/P1 feature and are acceptance-tested (tech.md §9). "Blocked" is treated as a bug class of its own:

| # | Guarantee | Plain promise to the user |
|---|---|---|
| **G1 Atomicity** | An operation happens 100 % or not at all. A file never appears "half-uploaded": it materializes only when every byte is committed (single finalize transaction). |
| **G2 Consistency** | Every operation moves the system between valid states: quota always equals reality, folder tree never loops, a file always has exactly one home. Corrupt accounting is a bug by definition. |
| **G3 Isolation (non-blocking)** | **No file operation ever blocks another.** Upload while downloading, rename while previewing, two devices in the same folder, delete during an open stream — all proceed. No global locks; only micro row-locks inside placement transactions. |
| **G4 Durability** | "Done" means done forever. Once the app says complete, bytes are on the provider **and** the DB says so — surviving tab kills, crashes, deploys, network loss. Completed uploads never silently vanish. |
| **G5 No limbo** | **A file is never stuck.** It is always in a named, recoverable state: uploading (resumable) / failed (retryable) / deleted (restorable from Trash) / purged (final). Every state has an automatic exit (resume, GC, reconcile) — "blocked forever" states are design bugs. |
| **G6 Idempotency** | Retries are free. Double-click, network replay, or resume can never duplicate a file or double-charge quota — any operation can safely run twice. |
| **G7 Read-your-writes** | What you do is visible immediately on every device — moves/renames/shares are metadata truth the instant they commit; provider lag never leaks into the UI. |
| **G8 Fault isolation** | One sick provider/account degrades only **its own** files (`needs_reauth` / `degraded` badges) — other accounts, uploads, and downloads keep working. |
| **G9 Eventual repair** | Out-of-band changes (someone edits Drive directly) are detected and healed by the reconciler; nothing silently diverges from the truth. |

## 6. Algorithm & Efficiency Research (how storage should behave)

| Concern | Chosen approach for v1 | Alternatives considered | Why |
|---|---|---|---|
| **Placement** | Best-fit by free space (`most_available`), with **DB-transaction reservations**; optional round-robin/priority | Weighted random, least-loaded | Matches 9Drive semantics; reservations must move from memory to DB for serverless (fixes L4) |
| **Big-file problem** | P0: require one account with space (honest error + "free up space" UI); P1: **fixed-size chunk striping** with ordered manifest | Erasure coding (P2), compression-first | Striping is simple, resumable-chunk-friendly, and reuses the upload protocol already needed for Vercel |
| **Dedup** | P0: none; P1: whole-file SHA-256 per user; P2: FastCDC variable CDC (~2–8 MB avg chunks, gear hash) | Fixed-size chunking (weaker dedup on shifted data) | CDC wins for backups/VM images — exactly this user's workload ([survey](https://dl.acm.org/doi/10.1145/373508)) |
| **Durability** | Single copy + trash/undo (P0); replication or RS erasure code (P2) | Daily backup job | Drive providers already replicate internally; cross-account parity only pays off once striping exists |
| **Quota freshness** | Cached with `lastSyncedAt`, refresh if stale >5 min, refresh async after each upload | Always-fresh (slow, rate-limits) | Google quota = ~1000 queries/100 s; must not sync per listing request |
| **Reads** | S3 presigned redirect (offload), Drive Range proxy streaming | Proxy everything | Egress through Vercel counts against plan bandwidth; redirect when provider allows scoped URLs |
| **Writes** | Chunked proxy ≤4 MB (default), direct-to-provider later | Vercel Blob staging buffer | Blob staging adds cost+copy step; only revisit if proxy bandwidth becomes the bottleneck |
| **Consistency** | DB is source of truth for *namespace*; periodic reconciliation repairs provider drift (renames/deletes done outside the app) | Provider-first | Same model as 9Drive's sync, but automated via cron |

---

## 7. Success Metrics

- Upload a 5 GB file from mobile data, kill the tab mid-way, reopen → resumes and completes.
- Works from a fresh device: open URL → sign in → all files present (< 10 s to first byte of a listing).
- Zero request/response over 4.5 MB in production logs (enforced by a test).
- A revoked share link stops working within 60 s.
- No function invocation hits `maxDuration` during a 10 GB download (redirect path).
- Reconciler detects a file deleted directly in Drive and marks it in-app within one cron cycle.

---

## 8. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Google account suspension for "storage gateway" automation patterns | High | Respect quotas, no scraping, human-like pacing, keep `9drive`-style single app folder per account, document that accounts are the user's own |
| Token theft from DB | High | AES-256-GCM at rest (key in Vercel env), hashed session/share tokens, HTTP-only cookies, short session TTL + rotation |
| Vercel bandwidth/egress cost on heavy streaming | Medium | Presigned redirects first; stream only when unavoidable; monitor with function logs |
| Function duration on huge Drive downloads | Medium | Range-chunked client fetch with resume; cap proxy file size behind config |
| Concurrent upload races double-allocating quota | Medium | Reservation rows in a transaction (not in-memory maps) |
| Provider drift (manual changes in Drive) | Medium | Automated reconciliation cron + on-demand sync |
| Single-account ban = data loss (L8) | Medium (accepted v1) | P1 striping spreads risk; P2 erasure coding; share/export tooling |
| Apache-2.0 attribution obligation | Low | Keep `NOTICE`/LICENSE reference to Zenhosta/9drive |

---

## 9. Open Questions (resolve during build spikes, before/while coding)

1. **CORS spike:** can the browser PUT chunks directly to `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` with a short-lived token? (If yes → P2-3 fast path; if no → server proxy stays canonical.)
2. **Stripe chunk size:** pick upload chunk size = min(4 MB, 4.5 MB − multipart overhead) vs raw-body endpoint at 4 MB with a `Content-Range` header (avoid multipart framing overhead). *Update (§11): if the free Worker relay is adopted, bodies ≤ 100 MB are legal ⇒ target 16–32 MB chunks; decide in S1/S2.*
3. **Neon vs Vercel Postgres vs Turso (LibSQL)** for the metadata store — decide on migration ergonomics with Prisma driver adapters. *Update (§11): all fit free; recommended = Neon Free + own daily offsite dump (Supabase Free rejected — no automated backups).*
4. **Striping manifest granularity (P1):** fixed 64 MB stripes vs content-defined chunks — measure re-upload blast radius when one chunk fails.
5. Should v1 reuse 9Drive's frontend structure (it's competent and complete) with a port to Next.js App Router, or rebuild UI fresh? (Current lean: port structure/pages 1:1, restyle incrementally — lower risk, faster to parity.)

---

## 10. Sources consulted

- 9Drive repo: [README](https://github.com/zenhosta/9drive), [AGENTS.md](https://github.com/zenhosta/9drive/blob/main/AGENTS.md), full file tree via GitHub API, `prisma/schema.prisma`, `backend/src/modules/uploads/upload.routes.ts`
- Vercel: [Functions Limits](https://vercel.com/docs/functions/limitations), [Upload & store files](https://vercel.com/kb/guide/how-to-upload-and-store-files-with-vercel), [Bypass 4.5MB KB](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions), [Hobby plan](https://vercel.com/docs/plans/hobby), [Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), [duration config](https://vercel.com/docs/functions/configuring-functions/duration)
- Google: [Drive usage limits](https://developers.google.com/workspace/drive/api/guides/limits), [Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- Ecosystem: [Neon + Next.js](https://neon.com/docs/guides/nextjs), [Prisma serverless drivers](https://www.prisma.io/blog/serverless-database-drivers-KML1ehXORxZV), [Better Auth vs Clerk vs NextAuth](https://makerkit.dev/blog/tutorials/better-auth-vs-clerk), [Auth.js joining Better Auth](https://github.com/nextauthjs/next-auth/discussions/13252), [Upstash QStash/Vercel Workflows](https://upstash.com/blog/serverless-background-jobs-and-message-queues-every-major-option-in-2026)
- Storage algorithms: [FastCDC (USENIX ATC '16)](https://www.usenix.org/system/files/conference/atc16/at16-paper-xia.pdf), [erasure coding](https://www.geeksforgeeks.org/system-design/erasure-coding-in-system-design/), [dedup survey](https://dl.acm.org/doi/10.1145/373508), rclone docs (union/chunker backends)
- Competitive: MultCloud, CloudMounter, [9-in-1-Cloud](https://github.com/smartworldarafath/9-in-1-Cloud), rclone.org

---

## 11. No-cost solution research (web-verified, Oct 2026)

Owner constraint: **v1 must run at $0/month.** Every worry raised in plan review got a free solution:

| # | Worry | Free solution (verified) |
|---|---|---|
| 1 | Striping parked in P1 ⇒ a 50 GB file needs one account with 50 GB free | **Promotion rule:** if your biggest file > your biggest account's free space, promote whole-chunk striping to **P0.6** — it reuses the existing chunk pipeline (design already keeps `stripe_plan` ready). Proven open design to port: rclone's [chunker backend](https://rclone.org/chunker/) — its issue tracker is a free lessons-learned list (overwrites leaving orphan chunks ⇒ our stripe cleanup must be transactional). Zero infra cost either way |
| 2 | Big Drive downloads depend on Vercel proxy speed (spike S1) | **Free escape hatch: Cloudflare Worker relay** — [free plan](https://developers.cloudflare.com/workers/platform/limits/): 100 k requests/day, **no response-body size limit**, **no hard wall-clock duration** while the client stays connected, 10 ms CPU (streaming = I/O, not CPU), request bodies up to 100 MB. 50 GB at 4 MB windows ≈ 12.8 k requests ≪ 100 k/day. Bytes flow browser ↔ Worker ↔ Drive ⇒ Vercel bandwidth ≈ 0. Fallback order: Vercel-direct (measure) → Worker relay → temporary public reader link (`confirm=t` — but the [daily per-file download quota](https://support.google.com/drive/thread/2035857) makes it opt-in only) |
| 3 | Metadata DB = single point of truth; no free backups | Neon Free restores only within **6–24 h** and Supabase Free has **no automated backups** ([docs](https://supabase.com/docs/guides/platform/backups)) ⇒ run our own: **daily `pg_dump -Fc` → AES-256-GCM → Cloudflare R2 free tier** (10 GB, $0 egress, offsite). Metadata is MBs for a single user ⇒ years of dumps fit. Backstop: same dump from GitHub Actions (free 2,000 min/mo) |
| 4 | Google ToS/automation risk | Zero-cost mitigations: OAuth consent stays in **Testing mode** (free, ≤100 users, [no verification needed at personal scale](https://support.google.com/cloud/answer/13464323)), strict per-account backoff, no public-link hot path, G8 blast-radius isolation. Residual: **contained, not eliminated** — honest status |
| 5 | No cost ballpark in docs | Table below |

### Free-tier stack (all verified Oct 2026)

| Service | Free allowance | Our use | Cost |
|---|---|---|---|
| Vercel **Hobby** | 100 GB Fast Data Transfer/mo, 1 M edge requests, 300 s functions, cron ≤ 100 jobs/project but **once/day each** | UI, JSON control plane, small-file proxy — big bytes bypass via relay | **$0** |
| Neon **Free** | 0.5 GB DB, 6–24 h restore history | metadata (MBs) + own dumps | $0 |
| Firebase **Spark** | 50,000 MAU (email/social sign-in) | 1 user | $0 |
| Cloudflare **Workers Free** | 100 k req/day, no response-size cap, no HTTP wall-clock cap, 10 ms CPU | optional byte relay (worry 2) | $0 |
| Cloudflare **R2 Free** | 10 GB storage, 1 M Class A / 10 M Class B ops, **egress always $0** | S3 provider #1 + backup dumps | $0 (past 10 GB: $0.015/GB-mo) |
| Backblaze **B2** (alt) | 10 GB, free egress up to 3× stored | alt S3 contract-test target | $0 |
| Google Drive / Cloud | your existing accounts; OAuth Testing mode free | primary storage + Drive API | $0 (your space) |
| GitHub Actions | 2,000 min/mo (private repos) | CI + dump backstop | $0 |
| Domain | `*.vercel.app` subdomain | production URL | $0 (own domain ≈ $12/yr, optional) |
| | | **Total** | **$0/month** |

First costs that could ever appear (only if forced): own domain (~$12/yr), Vercel Pro ($20/mo) if S1 rejects both relay options **or** hourly cron becomes mandatory, R2 beyond 10 GB ($0.015/GB-mo).

### What this research changed in the plan

- **Chunk size (§9.2):** Worker-relay bodies ≤ 100 MB are legal ⇒ target 16–32 MB chunks instead of 4 MB (fewer requests, same resumability); final size decided in spikes S1/S2.
- **DB choice (§9.3):** all candidates fit free → **Neon Free + own offsite dumps** recommended; Supabase rejected (free tier ships no backups).
- **Cron-dependent designs:** Hobby cron is daily-only (verified 2026) ⇒ every job idempotent, correctness via lazy expiry (`expires_at`), never via tick frequency (flow.md §8).
- **Spike S1 gains variant B** (measure the free Worker relay alongside Vercel-direct) — tech.md §7.
- **Rule added to AGENTS.md:** no paid service/dependency may enter the codebase; exceeding a free tier is a design escalation, not a commit.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [B2 pricing](https://www.backblaze.com/cloud-storage/pricing) · [Vercel limits](https://vercel.com/docs/limits) · [Vercel cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Firebase pricing](https://firebase.google.com/pricing) · [Neon plans](https://neon.com/docs/introduction/plans) · [Supabase backups](https://supabase.com/docs/guides/platform/backups) · [Google consent screens](https://support.google.com/cloud/answer/13464323) · [Drive download quota](https://support.google.com/drive/thread/2035857) · [rclone chunker](https://rclone.org/chunker/)
