# DriveThrough — Technical Requirements (tech.md)

> End-to-end technical spec: stack, platform constraints, data model, APIs, security, and delivery.
> Companion docs: [prd.md](./prd.md) · [flow.md](./flow.md) · [design.md](./design.md)
> **Build has not started.** This is what the build must satisfy.

---

## 1. Hosting & platform baseline

| Item | Requirement |
|---|---|
| Hosting | Vercel, **one GitHub monorepo (`github.com/Manthan1418/drivethrough`) = two Vercel projects** (owner decision Oct 2026; git hosting revised to monorepo 2026-10-20): each Vercel project sets Root Directory to `drivethrough-app` / `drivethrough-api`. Each gets its own preview + production deploys. Both Hobby-plan eligible → $0. |
| Framework | **Next.js (App Router) in both repos.** Backend = **route handlers only** (no pages). Frontend = pages + client components. Replaces 9Drive's Express + Vite pair — but split across a real API boundary, not one deployable. |
| API boundary | Frontend ↔ backend are **cross-origin**. Frontend sends `Authorization: Bearer <firebase-id-token>` on every call — **no cookies** (cross-site cookies would need a shared paid domain + `SameSite=None`), which also makes calls CSRF-immune. Backend CORS allows the frontend origin; preflight must allow `PUT` + `Content-Range` (chunk upload) and `GET` + `Range` (download/preview), and expose `Content-Range` on responses. |
| Shared contract | API request/response shapes, Zod validation schemas, and error codes live in a tiny **public `contracts` git repo** (no secrets) consumed by *both* repos as a git dependency (`github:…/drivethrough-contracts`). Single source of truth; the backend validates inputs with the same schemas the frontend types against. Fallback if git-dep friction annoys: thin duplicated types per repo. |
| Env split | **Backend** (`drivethrough-api`): `DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `CORS_ALLOW_ORIGIN`, optional `RECAPTCHA_*`. **Frontend** (`drivethrough-app`): `NEXT_PUBLIC_FIREBASE_*` (public web config — safe by design), `NEXT_PUBLIC_API_URL`. No secret ever crosses the boundary; token verification happens only in the backend. |
| Runtime | Node.js runtime for handlers that need `fetch` streaming & crypto (Edge only for trivial redirect logic). |
| Region | Default `iad1` unless latency measurement says otherwise; single region (Google APIs are anycast-ish, provider egress dominates). |
| Database | **Postgres** — Neon or Vercel Postgres (Vercel Marketplace). NOT MySQL (9Drive's schema needs porting: `Char(36)`→`uuid`, `Json`→`jsonb`, indexes re-checked). |
| DB access | Prisma **driver adapter** (`@prisma/adapter-neon` / `@prisma/adapter-pg`) or Drizzle + `postgres.js` HTTP driver. Connection-per-invocation discipline: no long-held TCP pools; every query inside timeouts. |
| Background jobs | Vercel Cron for periodic jobs; **Vercel Workflows (or Upstash QStash)** for multi-step/retrying jobs (reconcile, big quota sweeps). No daemons, no `setInterval` in server code. |
| Auth | **Firebase Authentication** (chosen): Google popup + email/password, entirely client-side; route handlers verify the **Firebase ID token** server-side (`firebase-admin`, cached public keys) and map `firebase_uid` → `users` row. No password storage, no session table in our DB. |
| Secrets | All secrets in Vercel env (prod) — `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `TOKEN_ENCRYPTION_KEY` (32 B, AES-256-GCM), `GOOGLE_CLIENT_ID/SECRET`, optional `RECAPTCHA_*`. Never in client bundles (`NEXT_PUBLIC_*` forbidden for these; Firebase *web* config is public by design but only after verifying tokens server-side). |
| Limits honored | request body ≤ 4.5 MB; non-streamed response ≤ 4.5 MB; `maxDuration` set per route (300 s Hobby / up to 800 s Pro for the Drive stream proxy); function bundle ≤ 250 MB. |

**Hard technical rules (from prd.md §4):**
- R1: no payload > 4.5 MB through a function except streamed bodies.
- R2: file bytes never fully enter function memory (stream request → upstream via `ReadableStream`/`duplex: 'half'`).
- R3: prefer 302-to-provider (S3 presigned) over proxying bytes; proxy only for Google Drive.
- R4: correctness must not depend on any long-lived process or in-memory state (all state in Postgres).

---

## 2. Repository structure (target) — one monorepo, three packages, two Vercel projects

Everything lives in a single git repo (`github.com/Manthan1418/drivethrough`, owner decision 2026-10-20, superseding the original "separate repos" rule): spec docs at the root, packages under `repos/`, npm workspaces at the root `package.json`. **Deployment separation is unchanged** — the two apps are still two Vercel projects (Root Directory per project), still never import each other, still talk over HTTP only.

**Package — `repos/drivethrough-api`** (backend; Vercel project `drivethrough-api`, Root Directory `repos/drivethrough-api`):
```
drivethrough-api/
├── package.json  tsconfig.json  next.config.ts  vercel.json   # vercel.json owns cron + maxDuration
├── drizzle/ or prisma/                    # migrations (Postgres) — schema source of truth
├── src/
│   └── app/
│       └── api/…                          # route handlers ONLY, per flow.md §9 (no pages)
│   └── server/
│       ├── auth/                          # Firebase ID-token verification guard (bearer), user-row mapping
│       ├── db/                            # client, schema, queries, transactions
│       ├── crypto/                        # AES-GCM token vault, hashing helpers
│       ├── providers/                     # provider abstraction (see §5)
│       │   ├── types.ts  google-drive.ts  s3.ts  index.ts
│       ├── storage/                       # placement engine, reservations, quota
│       ├── uploads/                       # init/reserve/chunk/complete services
│       ├── downloads/                     # signed-url + range proxy services
│       ├── jobs/                          # cron/workflow handlers
│       └── cors.ts  audit.ts  errors.ts  ratelimit.ts
└── tests/                                 # unit + integration + contract
```

**Package — `repos/drivethrough-app`** (frontend; Vercel project `drivethrough-app`, Root Directory `repos/drivethrough-app`):
```
drivethrough-app/
├── package.json  tsconfig.json  next.config.ts
├── src/
│   ├── app/                               # App Router pages only (no API routes)
│   │   ├── (auth)/sign-in | sign-up
│   │   ├── (app)/files | recent | starred | shared | trash | quota | settings | activity | keys
│   │   └── s/[token]/                     # public share page
│   └── client/
│       ├── api.ts                         # typed fetch client → NEXT_PUBLIC_API_URL, attaches bearer token
│       ├── components/ uploader/          # UI, upload queue (slice · retry · resume → hits api)
│       └── firebase.ts                    # Firebase client SDK init (sign-in only)
└── tests/                                 # e2e (Playwright) against both deploys
```

**Package — `repos/drivethrough-contracts`** (shared, public, no secrets): Zod schemas + inferred TS types for every request/response shape and error code in flow.md §9. Both apps resolve it as an **npm workspace** (`"@drivethrough/contracts": "*"` — built to `dist/` by the root `postinstall`), so the frontend and backend can never disagree on the wire format, with no git URLs and no `<ORG>` placeholders.

**Note (flexibility requirement, owner 2026-10-20):** the frontend is expected to be re-altered later for difficulty/functionality/ease — so keep it loosely coupled to the contract (types-only import from `contracts`, no logic imported from `api`), keep `client/api.ts` the single choke-point for all network calls, and keep styling in a swappable token layer (design.md §5.3). Restructuring the UI must never require touching the backend.

Docs (`prd.md` `flow.md` `tech.md` `design.md` `AGENTS.md` `BUILD-STATUS.md` `opencode.jsonc`) live at the **monorepo root**, beside the root `package.json` (workspaces: `repos/*`); `.opencode/` is local-only and gitignored (it may contain pasted secrets). One clone of `github.com/Manthan1418/drivethrough` gets docs + all three packages.

---

## 3. Data model (Postgres)

Port of 9Drive's Prisma schema with serverless corrections. Core tables (columns abridged; full DDL at build time):

```
users                 id, firebase_uid UNIQUE, email, name, avatar_url, created_at
                      (identity lives in Firebase Auth — no password/session tables here)
accounts              id, user_id, provider[google_drive|s3], email/label, status[connected|needs_reauth|disabled],
                      provider_account_id, root_folder_id,
                      access_token_enc? refresh_token_enc? token_expires_at   -- AES-GCM at rest
                      s3_endpoint/region/bucket/access_key_enc/secret_key_enc/prefix/quota_bytes (nullable)
                      last_error, last_synced_at
storage_usage         account_id PK, total_bytes, used_bytes, available_bytes, trash_bytes, reserved_bytes, synced_at
files                 id, user_id, account_id, folder_id?, provider, provider_file_id,
                      name, mime_type, size_bytes, checksum_sha256?, status[active|deleted|purged],
                      stripe_index?, stripe_count?, parent_file_id?          -- P1 striping
                      created_at, updated_at, deleted_at
file_stripes          file_id, index, account_id, provider_object_id, size_bytes, offset_bytes   -- P1
folders               id, user_id, parent_id?, name, color, icon, pinned_account_id?, deleted_at
uploads               id, user_id, file_name, mime_type, size_bytes, folder_id?, chunk_size,
                      total_chunks, status, account_id?, provider_session_uri?,
                      target_root_folder_id?, stripe_plan jsonb?, error, created_at, completed_at
upload_chunks         (upload_id, index) PK, status, size_bytes, provider_offset?, updated_at    -- resume source of truth
reservations          id, upload_id?, user_id, account_id, bytes, expires_at    -- released on complete/abort/GC
shares                id, file_id, user_id, token_hash, enabled, expires_at?, role[viewer], created_at
preview_tokens        id, file_id, token_hash, expires_at
api_keys              id, user_id, name, key_prefix, key_hash, scopes jsonb, last_used_at, revoked_at
oauth_states          id, provider, state_hash, flow, expires_at, used_at
invites               id, inviter_id, email, target_type, target_id, role, status
audit_logs            id, user_id?, action, entity_type, entity_id, metadata jsonb, created_at
```

**Indexes required before hot paths** (9Drive lesson kept):  
`files(user_id, status, folder_id, created_at DESC)`, `files(user_id, status, name)`, `uploads(user_id, status)`, `upload_chunks(upload_id, index)`, `reservations(account_id)`, `audit_logs(user_id, created_at)`, `shares(token_hash)`, `preview_tokens(token_hash)`.

**Quota invariant:** `storage_usage.used_bytes = Σ active files on account` and `reserved_bytes = Σ live reservations` — both maintained transactionally (upload completion adds usage; reservation add/remove in same txn as placement). A daily job recomputes and repairs drift.

### Consistency & concurrency model (ACID-for-files, prd.md §5.4 G1–G9)

| Guarantee | Mechanism | Verified by |
|---|---|---|
| G1 Atomicity | `files` row created in the **same transaction** that flips `uploads → completed` and adjusts usage; bytes are staged in `upload_chunks` until finalize | integration: kill during finalize |
| G2 Consistency | All invariants enforced in txn-guarded writes (quota = Σ active files, `reserved ≤ available`, acyclic folders checked in move service); nightly recount is a safety net, not the mechanism | unit: invariant suite |
| G3 Isolation | Postgres MVCC; **no table/global locks in app code** (review-enforced); placement uses one short `SELECT … FOR UPDATE` on the usage row; provider operations are object-scoped, so open streams never conflict with ops on other files/accounts | concurrency test: 50 parallel uploads + streams |
| G4 Durability | provider ack required before chunk status `committed`; `completed` only after provider 200 **and** DB commit; all state in Postgres (R4) so instance recycling loses nothing | integration: resume-after-crash suite |
| G5 No limbo | explicit state machines with terminal-state guards (`uploads.status`, `files.status`); every non-terminal state has a cron exit (session GC 48 h, reservation `expires_at`, reconciler); UI always renders the current named state | e2e: kill-tab resume; GC tests |
| G6 Idempotency | `clientUploadId` unique init; chunk upsert keyed `(upload_id, index)`; `complete` guarded by state transition (second call = same result); share/key creation via client-supplied UUIDs | integration: replay suite |
| G7 Read-your-writes | namespace truth = Postgres read-after-commit; no cache in front of listings (P0); provider rename lag hidden behind reconciler | e2e: cross-device check |
| G8 Fault isolation | per-account state (`connected / needs_reauth / degraded`) + scoped backoff; provider errors never abort unrelated requests | contract tests: induced 403s |
| G9 Eventual repair | daily + on-demand reconciler `diff()`; drift surfaced as Trash entries / account badges, never silent | contract test: out-of-band delete |

**Merge rule:** any new write path must state its G1–G9 story (atomic? non-blocking? idempotent? limbo-free?); if it can't, it isn't mergeable.

---

## 4. API contract (delta summary)

Full route list: [flow.md §9](./flow.md). Contract requirements:

- Auth: Firebase ID token via `Authorization: Bearer <idToken>` (bearer-only — cross-origin two-repo boundary, no session cookies); `Authorization: Bearer <api-key>` for `/api/v1/*`.
- All bodies JSON ≤ 4.5 MB; uploads are `PUT` with `Content-Range` raw binary body (NOT multipart — avoids framing overhead and keeps chunk exactly ≤ 4 MB; the `init` call carries metadata).
- Errors: `{ code: string, message: string }`, HTTP status semantically correct; codes stable (`UNAUTHENTICATED`, `NO_ACCOUNT_WITH_ENOUGH_SPACE`, `UPLOAD_SIZE_MISMATCH`, `CHUNK_OUT_OF_ORDER`, `ACCOUNT_NEEDS_REAUTH`, `RATE_LIMITED`, `FILE_TOO_LARGE_FOR_PLAN`).
- Upload protocol (server-authoritative offset):
  - `POST /api/uploads/init` → `{ uploadId, chunkSize, totalChunks, receivedChunks[] }` (idempotent via client-generated `clientUploadId`, so double-click/retry doesn't fork sessions).
  - `POST /api/uploads/reserve` → placement + Drive resumable `sessionUri` (Drive) or presigned part URLs (S3 direct mode) or `{mode:"proxy"}`.
  - `PUT /api/uploads/chunk/:id?index=i` headers `Content-Range: bytes a-b/total` → streams body upstream → `{ committedOffset }`. Must be idempotent for retries.
  - `GET /api/uploads/:id` → `{ status, committedOffset }` for resume (server verifies against provider `308 range` when ambiguous).
  - `POST /api/uploads/:id/complete` → validates byte totals, creates `files` row(s), releases reservation, enqueues quota sync.
  - `POST /api/uploads/:id/abort` → releases reservation, kills provider session.
- Rate limits: auth endpoints (10/min/IP), chunk endpoint (sustained-friendly but bounded: e.g. 600/min/user to allow 4 MB × 10/s), API-key uploads keyed by user+key. In-Postgres fixed-window or Upstash Redis if needed; must work serverless (no memory counters).

---

## 5. Provider abstraction (the core interface)

```ts
interface StorageProvider {
  kind: 'google_drive' | 's3'
  // lifecycle
  ensureRoot(): Promise<string>                       // app root folder / key prefix
  getQuota(rootId): Promise<{ total|null, used, available|null }>
  // write
  beginUpload(ctx): Promise<BeginResult>              // Drive: resumable sessionUri; S3: presigned parts OR proxy mode
  putChunk(ctx, index, range, body: ReadableStream): Promise<{ committedOffset }>
  queryOffset(ctx): Promise<number | 'complete' | 'unknown'>   // Drive 308 range check
  completeUpload(ctx): Promise<{ providerFileId, name, size }>
  abortUpload(ctx): Promise<void>
  // read
  signDownloadUrl(ctx, ttl): Promise<string | null>   // S3 presigned; Drive returns null → proxy
  openRead(ctx, range?): Promise<ReadableStream & { status, headers }>   // Drive alt=media Range proxy
  // manage
  delete(ctx, soft?: boolean): Promise<void>
  listChildren(rootId): AsyncIterable<ProviderObject> // reconciliation
}
```

Placement engine (`storage/placement.ts`) consumes only `getQuota`-derived rows + reservations — provider-agnostic. Adding Dropbox/OneDrive later = one new provider file + migration enum.

**Google Drive specifics:** raw `fetch` preferred over `googleapis` (bundle size): OAuth token refresh via `refresh_token` grant, resumable handshake `POST /upload/drive/v3/files?uploadType=resumable`, chunk `PUT` with `Content-Range` (multiples of 256 KB), `308` handling, `files.get?alt=media` with Range for reads, `permissions.create {type:'anyone', role:'reader'}` **only** when a share requires it (never `writer` — fixes 9Drive L6), root folder creation + `AppData`-style isolation decision documented at build time. Exponential backoff on 403 `userRateLimitExceeded` / 429.

**S3 specifics:** AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), path-style option for MinIO, part size ≥ 8 MB (S3 multipart minimum) with chunk endpoint mapping N app-chunks → 1 part or app chunk = part (decide: **chunkSize = max(4 MB, s3PartSize)** chosen so the same client loop works for both providers), `CompleteMultipartUpload` on finish, `AbortMultipartUpload` on GC.

---

## 6. Upload & download engine requirements

### Upload
1. Client (Web Worker or main thread): `File.slice()` loop, concurrency 3, per-chunk retry ×3 with jittered backoff, pause/resume, progress events; **never reads whole file into memory**; SHA-256 computed incrementally (WebCrypto) → stored as `checksum_sha256` (enables P1 dedup).
2. Server chunk handler: validate session ownership + index + range against expected size; stream `req.body` → provider (`duplex: 'half'`); enforce per-chunk byte cap; write `upload_chunks` row; return committed offset. **Must not** `await req.text()`/buffer.
3. Resume: on page load, in-progress sessions listed from DB; client asks server for `committedOffset` (authoritative from `upload_chunks`, cross-checked with provider offset for Drive) and continues from `index = ceil(offset/chunkSize)`.
4. Concurrency safety: reservations in txn with `SELECT … FOR UPDATE` on `storage_usage`; round-robin cursor incremented atomically.
5. Limits: `MAX_UPLOAD_BYTES` env (default 50 GB), per-plan guard (`FILE_TOO_LARGE_FOR_PLAN` when Hobby duration can't sustain Drive proxy — computed from size and measured throughput, see §7).

### Download / preview
1. S3: `GET …/download-url` → 302 presigned URL (TTL ≤ 5 min). No bytes through Vercel.
2. Drive: `GET …/content` with optional `Range` → server streams upstream `alt=media` response straight to client (`ReadableStream` piping, status/headers passthrough for 206). Set `maxDuration` (e.g. 300–600) + `Cache-Control: private, no-store` for previews, `private, max-age=…` for share pages.
3. Striped files (P1): read planner fetches stripes in order with bounded parallelism (2), concatenates into one outgoing stream with correct `Content-Length` (sum) and Range math handled by planner.
4. Preview tokens & share pages go through the same read service with a permission resolver in front.

---

### The 50 GB walkthrough (cap math — how a huge file stays usable)

The cap is **per request, not per file**: Vercel limits one conversation at the door, never the file itself.

| Operation on a 50 GB file | Path | Vercel's role | Feels like |
|---|---|---|---|
| Move / rename / re-folder / star / share | DB write only (virtual namespace) | JSON only | **instant** — zero bytes move |
| Upload | 12,800 × 4 MB chunks (resumable); S3 = presigned browser-direct, Drive = chunk proxy | sign (S3) / forward (Drive) | bounded by the **user's uplink** (20 Mbps ≈ 6 h); survives tab kill via resume |
| Preview / video seek | Range request for just the needed window (response windows capped ≤ 16 MB) | small stream | seconds |
| Download — S3 account | one `302` → presigned GET | **not in the path** | full provider speed (R2 = zero egress); 100 Mbps ≈ 68 min for 50 GB |
| Download — Drive account | client **range downloader**: N parallel requests ≤ 16 MB each, reassembled in-browser (File System Access API `createWritable()`, Blob fallback) | many small legal requests, each far under duration limits | ≈ min(client bandwidth, Drive↔Vercel); no single request ever sees 50 GB |

Why a single-stream Drive proxy cannot carry 50 GB: Pro's 800 s ceiling would need ~64 MB/s sustained (Hobby 300 s ⇒ ~170 MB/s) — unrealistic ⇒ size guard `FILE_TOO_LARGE_FOR_PLAN` routes big files to the range downloader instead of failing (tech.md §7 S1 fallback; design.md §3.3 fallback menu). Optional P1: one-click "temporary public reader link" (auto-revoke) so the browser pulls straight from Google — 0 Vercel egress, but caveats: virus-scan interstitial on huge files + hot-link throttling ⇒ off by default.

Egress accounting: S3 presigned path = 0 Vercel egress; Drive range downloader = bytes count against plan bandwidth (Pro 1 TB/mo included) — log response bytes per route (tech.md §10) and surface a monthly meter in the Quota UI.

Escape hatches if Drive relay ever becomes the bottleneck, in order: (1) more S3 accounts (unaffected), (2) browser-direct Drive after spike S2 / P2-3, (3) relocate only the proxy host (providers sit behind `StorageProvider` — the courier can change without touching the product).

## 7. Platform-specific risk table (must be spiked early)

| # | Risk | Verification spike | Fallback |
|---|---|---|---|
| S1 | Drive proxy throughput × `maxDuration` on Hobby (300 s) for multi-GB downloads | measure MB/s in a prod deploy — **variant A:** Vercel streamed function; **variant B:** free Cloudflare Worker relay (~80 LoC, HMAC relay ticket) | cap proxied response windows (≤ 16 MB) + browser range downloader; **if Vercel throughput or the 100 GB/mo bandwidth budget is the limiter → adopt the free Worker relay** (no response-size cap, no wall-clock cap while connected, 100 k req/day — prd.md §11); last resort: temporary public reader link (daily-per-file-quota limited, opt-in) |
| S2 | Chunk PUT through function: does `duplex:'half'` streaming hold under Vercel's body handling? | deploy minimal handler, push a 4 MB chunk, watch memory + latency | switch to multipart formData ≤ 4.5 MB; **or relay chunk PUTs through the Worker (accepts streaming bodies ≤ 100 MB) ⇒ chunks may grow to 16–32 MB** (fewer requests); or direct-to-Drive (P2-3) |
| S3 note | *(not a risk — the good path)* presigned PUT/GET proves the design intent: function only signs | — | — |
| S4 | Neon pooling behavior under bursty chunk requests | load test 50 concurrent chunk PUTs | HTTP driver / pgbouncer mode; keep chunk path DB-light (single upsert) |
| S5 | Firebase ID-token verification from a **cross-origin** frontend (CORS preflight + bearer header reach the guard correctly) | initial scaffold of both repos | if preflight overhead on chunk PUTs hurts: move chunk route to a CORS-friendly shape or colocate uploader on api domain via rewrite |
| S6 | Cron budget on Hobby — **verified 2026:** up to 100 cron jobs/project on every plan, but Hobby triggers **once per day** each | confirm quota + timing jitter in deploy | jobs idempotent + lazy expiry (`expires_at`) so daily cadence is *correct*, not merely frequent; anything needing sub-daily runs uses **event triggers** (e.g. quota sync after upload = plain function call, free) or QStash free tier |

Spikes S1–S2 happen **before** building the full UI (they can invalidate §6 choices).

---

## 8. Security requirements

- Identity: **Firebase ID token** (≈1 h TTL, auto-refreshed by SDK) verified on every protected request (`firebase-admin`, cached keys), delivered as `Authorization: Bearer <token>` from the frontend's `api.ts`. **No session cookie** — the two-repo cross-origin boundary makes same-site cookies impractical, and bearer-token calls are CSRF-immune (no CSRF tokens needed). Revocation check (`checkRevoked`) for sensitive ops: connect/disconnect account, purge, key create.
- CORS: backend allows **only** the frontend origin (`CORS_ALLOW_ORIGIN`, set to the `drivethrough-app` production + preview URLs); preflight permits `PUT` + `Content-Range` (chunk upload) and `GET` + `Range` (download/preview); responses expose `Content-Range`. No wildcard origin, no `Allow-Credentials` (bearer, not cookies).
- Token vault: `TOKEN_ENCRYPTION_KEY` AES-256-GCM (unique IV per row, AAD = account id); keys never logged.
- Hashing: SHA-256 for all bearer-style secrets (share, preview, API keys, oauth states) — lookup by hash only (9Drive convention, kept). Passwords never touch our DB: Firebase owns credentials.
- Uploads: ownership checks on every chunk (session belongs to user); folder path validated; mime allowlist per category; zip-bomb/oversize guards; **no execution of uploaded content**; share links default private/read-only/expiring; explicit `role:'reader'` for any public Drive permission.
- Egress SSRF guard on S3 endpoint field (allow only http(s), block link-local/metadata IPs unless `ALLOW_PRIVATE_ENDPOINTS=true` for MinIO).
- Rate limiting (§4), audit logging for: sign-in, connect/disconnect account, upload complete, delete/purge, share create/revoke, key create/revoke.
- Secrets hygiene: `.env.example` committed, real `.env` git-ignored; no provider tokens in client responses (never return `sessionUri`/presigned PUT URLs to *other* users; they are per-upload, per-user, TTL-scoped).
- License: retain Apache-2.0 attribution to zenhosta/9drive in NOTICE.

---

## 9. Testing & quality gates

| Layer | Tooling | Must-cover |
|---|---|---|
| Unit | Vitest | placement engine (all 3 policies + reservations + pinning), range/offset math, crypto vault, chunk index math, stripe planner (P1) |
| Integration | Vitest + test Postgres (Neon branch) + mock provider (in-process fake implementing `StorageProvider`) | full upload state machine incl. resume, idempotent chunk retry, complete/abort/GC, quota invariant |
| Contract | against **real** Google Drive (staging project) + MinIO (local docker) | resumable handshake, 308 handling, Range proxy, presign flows |
| E2E | Playwright | sign-in, connect, browse, upload (kill-tab resume), preview, share+revoke, trash+restore |
| Static | tsc strict, ESLint, `next build` | CI on every PR |
| Guard tests | custom | assert no handler buffers > 4.5 MB (scan for `await req.arrayBuffer()`/`req.text()` in upload paths), assert no `role:'writer'` public permissions |

CI/CD: GitHub Actions (typecheck+test) → Vercel preview deploy per PR → production on merge to main. Migrations run in deploy step (`prisma migrate deploy` / `drizzle-kit push`) and must be backward compatible with the previous release (expand-contract).

---

## 10. Observability & operations

- Structured JSON logs per invocation (user id, upload id, account id, latency, bytes) — Vercel log drain; **never** log tokens/URLs with credentials.
- Per-upload timeline reconstructable from `uploads` + `upload_chunks` + `audit_logs`.
- Health: `GET /api/health` (DB ping, provider auth statuses aggregated, last cron run timestamps) → settings page diagnostics card.
- Alerts (P1): cron failure, `needs_reauth` account, quota-sync stale > 24 h, error-rate spike — via Vercel hooks/QStash failure notifications.
- Cost telemetry: log response byte counts per route to estimate egress; monthly review against plan.
- **Disaster recovery (free):** daily `pg_dump -Fc` → AES-256-GCM encrypt → Cloudflare R2 free tier (offsite, $0 egress); retain 30 daily + 12 monthly. Neon's 6–24 h restore history covers *mistakes*; the dump covers *account loss*. Backstop dump from GitHub Actions weekly (free 2,000 min/mo). Metadata volume ⇒ years of dumps fit in R2's free 10 GB (prd.md §11).

---

## 11. Performance budgets

- File listing: p95 < 300 ms (indexed queries, no N+1).
- Chunk accept (server): p95 < 400 ms overhead beyond network; sustain ≥ 8 MB/s per client on Pro.
- Time-to-first-byte preview: < 1 s for small files (Drive) — measured via synthetic check.
- Zero full-file buffering anywhere (guard test in §9).
- Page weight: initial route JS < 200 KB gz (uploader in dynamic import).

---

## 12. Delivery phases (build order, gated by this doc)

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0.0 – Spikes** | S1, S2, S5 from §7 + DB port of schema | spike memo in repo; go/no-go on §6 choices |
| **P0.1 – Foundation** | repo scaffold, Next.js app shell, Firebase Auth (sign-in + token guard), Postgres schema+migrations, crypto vault, provider interface + S3 provider | sign-in works, connect MinIO/R2, quota shows |
| **P0.2 – Google** | Google provider: OAuth connect, resumable upload proxy, Range download proxy, quota sync | real Drive E2E contract test green |
| **P0.3 – Core UX** | folders/files CRUD, uploader UI w/ resume, trash, search, activity | e2e "flaky mobile upload" passes |
| **P0.4 – Sharing/API** | shares+preview tokens, public page, API keys, `/api/v1/uploads`, rate limits | revoke test passes |
| **P0.5 – Jobs+cron** | reconcile, purge, session GC, quota cron, **metadata backup (daily dump → R2)**, health | jobs idempotent **at daily cadence**; dump restores clean in a test DB; dashboard diagnostics |
| **P0.6 – Harden** | guard tests, load test, docs polish, attribution | all §9 gates green → **v1 ship** |
| **P1** | striping, whole-file dedup, PWA offline queue, 2FA, versioning | per prd §5.2 |
| **P2** | erasure coding, FastCDC, browser-direct Drive, more providers | per prd §5.3 |

---

## 13. Explicit non-requirements (v1)

- No real-time co-editing/sync engine (no block-level delta sync; full-file uploads only).
- No public self-serve signup (owner + invited users).
- No media transcoding/thumbnail pipeline (provider thumbnails + client-side rendering only).
- No desktop FUSE mount (rclone gateway = P1 stretch).
- No guarantee against provider-side account bans (documented risk, prd §8).
