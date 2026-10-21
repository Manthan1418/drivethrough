# Roadmap: getting the Google OAuth credentials to connect a Drive account

> One-time, ~10 minutes, completely free. These steps create the app's "passport" to Google
> (Client ID + Secret). They happen **in Google's console** — no app can do them for you.
> Once created, the values are pasted into DriveThrough's **Settings form** (not env vars —
> the 9Drive-parity in-app config). `GOOGLE_*` env entries are only a local-dev fallback.

## Phase 0 — Before you start

- You need: one Google account (the Drive you want to connect), and a browser that can reach
  `console.cloud.google.com` (if you saw `ERR_CERT_COMMON_NAME_INVALID` earlier, your network
  intercepts Google — use a mobile hotspot for this setup).
- The "unverified app" warning during consent is **normal** for your own app in Testing mode.

## Phase 1 — Create the project (2 min)

1. Open 👉 **https://console.cloud.google.com/** and sign in with that Google account.
2. Project dropdown (top-left) → **New Project** → name `DriveThrough` → **Create**.
3. Wait for creation, then make sure the top bar shows **DriveThrough** (the dropdown).

## Phase 2 — Enable the Drive API (1 min)

4. Open 👉 **https://console.cloud.google.com/apis/library/drive.googleapis.com**
   (confirm the project selector says DriveThrough) → **Enable**.

## Phase 3 — OAuth consent screen (4 min)

5. Open 👉 **https://console.cloud.google.com/apis/credentials/consent**
6. User type: **External** → **Create**.
7. App information: app name `DriveThrough` · user support email = your Gmail ·
   developer contact = your Gmail → **Save and continue**.
8. **Scopes** → **Add or remove scopes** → search `drive` → tick
   `https://www.googleapis.com/auth/drive` (the full Drive scope) → **Update** → **Save and continue**.
   - Why full scope: DriveThrough must manage files *and* create reader-only share links;
     it never issues `writer` permissions (prd.md / design.md rule).
9. **Test users** → **Add users** → type your Gmail → **Save and continue** → **Back to dashboard**.
   - In Testing mode only added test users can consent — you're added, so you're covered.
     Publishing/verifying the app with Google is **not** needed for personal use.

## Phase 4 — Create the OAuth client (3 min)

10. Open 👉 **https://console.cloud.google.com/apis/credentials**
    → **Create Credentials** → **OAuth client ID**.
11. Application type: **Web application**. Name: `drivethrough-web`.
12. **Authorized redirect URIs** → **Add URI** → paste **exactly** (the Settings card's Copy
    button gives you this string):
    ```
    https://drivethrough-kek7.vercel.app/api/accounts/google/callback
    ```
    - Optional second URI if you'll run the backend locally:
      `http://localhost:3001/api/accounts/google/callback`
    - `https`, correct `kek7` domain, **no trailing slash**.
    - Leave *Authorized JavaScript origins* empty (redirect flow, no popup).
13. **Create** → a popup shows your **Client ID** (`….apps.googleusercontent.com`) and
    **Client secret** (`GOCSPX-…`). Copy both now — **the secret is shown only once**.
    Lost it? Delete this client in the list and create a new one (2 min).

## Phase 5 — Paste into DriveThrough (1 min)

14. Open 👉 **https://drivethrough-navy.vercel.app/settings**
    → card **"Google Drive API credentials"**.
15. Paste the **Client ID** and **Client secret**; the **Redirect URI** field is already
    pre-filled with the correct `kek7` URL (use **Copy** for step 12). → **Save credentials**.
    - The chip flips to **Configured**; the secret can never be read back (write-only).
    - Local dev only, optionally: same two values into `repos/drivethrough-api/.env`
      (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). Not needed for prod.

## Phase 6 — Connect the account (1 min)

16. Click **Connect Google Drive** → Google's own page opens → pick the account →
    **Advanced → Go to DriveThrough (unsafe)** → **Allow/Approve** → you land back on
    Settings with the account card + synced quota.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Button greyed out / 503 before saving | Expected — no credentials yet. Do Phase 5 first. |
| Google error `redirect_uri_mismatch` | The URI in GCP differs byte-for-byte. Edit the client in Phase 4 step 12; no re-pasting needed. |
| Google error `invalid_client` | Wrong/rotated Client ID or secret — re-paste in Phase 5; or the client was deleted. |
| "Access blocked: app isn't verified" | Click **Advanced → Go to DriveThrough**. Still blocked ⇒ you're not in Test users (Phase 3 step 9). |
| Consent loop / "stopped application" | The OAuth client was deleted in GCP — recreate (Phase 4) and re-paste. |
| `console.cloud.google.com` won't load | Network intercepts Google (cert error) — use a hotspot (Phase 0). |
| Secret lost after creation | GCP never shows it again — delete the client, create a fresh one, re-paste. |

## What each value is for (keep-safe notes)

- **Client ID** — public "who is this app" marker; rides in every consent URL; stored encrypted
  but not secret-classified.
- **Client secret** — proves only the DriveThrough backend may exchange auth codes for tokens.
  Stored AES-256-GCM in `provider_configs`; **write-only over the wire** (`hasSecret` only).
  Treat it like a password; never paste it in chat.
