# 🚀 Connect Google Drive to DriveThrough — the picture-book setup

> **Who this is for:** anyone, no experience needed. Just start at Step 1 and go down.
> **Time:** ~10 minutes. **Cost:** ₹0 / $0 — everything here is free.
> **Rule:** every step shows 🖱️ what to click, 👀 what you should see, ✅ how to know it worked.

---

## 🧭 Your whole journey on one screen

| Phase | What you're doing | Time | Done? |
|---|---|---|---|
| 1 | 🏗️ Create a "project" (a workspace at Google) | 2 min | ☐ |
| 2 | ⚡ Turn on the Drive API | 1 min | ☐ |
| 3 | 📝 Fill the consent form (what your app asks for) | 3 min | ☐ |
| 4 | 🔑 Create the keys: **Client ID + Secret** | 2 min | ☐ |
| 5 | 📋 Paste the keys into DriveThrough's Settings | 1 min | ☐ |
| 6 | 🎉 Press **Connect Google Drive** | 1 min | ☐ |

---

## 🧠 What are "credentials", in plain words? (30 seconds, no jargon)

Google will give you **two strings** — think of them as your app's **name tag** and **password**:

| The string | Looks like | It's like | Keep it safe? |
|---|---|---|---|
| **Client ID** | `12345-abc.apps.googleusercontent.com` | Your app's **name tag** — Google shows it on the consent screen | Not secret, but keep it tidy |
| **Client secret** | `GOCSPX-...` | Your app's **password** — only your server may use it | 🤫 **Yes — like a password. Never chat/email it.** |

You create them **once**, at Google. DriveThrough then stores them **encrypted** (its Settings
form) — and every time you click *Connect Google Drive*, Google asks **you** (on Google's own
page) to pick an account and approve. **No app ever sees your Google password.**

> 💾 **Beginner tip before you start:** open a blank text file (Notepad/Notes) and keep it
> ready to paste the two strings into. Google shows the secret **only once**!

---

# ✅ Phase 1 — Create the project (2 min)

### Step 1 — Open the Google Cloud Console
🌐 Open: **https://console.cloud.google.com/**
🖱️ Sign in with **the Google account whose Drive you want to connect**.

> ⚠️ If the page shows a certificate error or won't load: your network is interfering with
> Google — switch to your phone's **mobile hotspot**, then reload.

### Step 2 — Make a new project
🖱️ Look at the **top-left corner**: there's a dropdown that may say *"Select a project"* or
shows some project name. **Click it.**
🖱️ A panel opens → click **New Project** (top-right of that panel).
⌨️ In "Project name" type: `DriveThrough`
🖱️ Click **CREATE** (bottom-right).
👀 You'll see a small spinning "Notifications" popup — wait ~15 seconds.

### ✅ Checkpoint 1
🖱️ Look at the top bar again — it must say **`DriveThrough ▾`**.
If it doesn't: click the dropdown and **select** DriveThrough from the list.

---

# ✅ Phase 2 — Turn on the Drive API (1 min)

### Step 3 — Enable it with one click
🌐 Open: **https://console.cloud.google.com/apis/library/drive.googleapis.com**
👀 You'll see a page titled **Google Drive API** with a big blue button.
🖱️ (If asked which project, pick **DriveThrough**.)
🖱️ Click **ENABLE**. Wait ~20 seconds until the page reloads.

### ✅ Checkpoint 2
The page now has tabs like *API Services / Credentials* at the top — that means it's on.
(If you ever need to disable it, you'd find it under APIs & Services → Enabled APIs.)

---

# ✅ Phase 3 — The consent screen (what your app is allowed to ask for) (3 min)

> This tells Google *what your app wants permission to do*, and lists **you** as a tester.

### Step 4 — Start the form
🌐 Open: **https://console.cloud.google.com/apis/credentials/consent**
🖱️ You'll see "Audience" or "OAuth consent screen": choose **External** → click **CREATE**.

### Step 5 — Basic info
Fill the form:

| Field | Type this |
|---|---|
| App name | `DriveThrough` |
| User support email | pick **your Gmail** from the dropdown |
| Developer contact information | type **your Gmail** |

🖱️ Click **SAVE AND CONTINUE** (bottom).

### Step 6 — Scopes (what access the app may request)
🖱️ Click **ADD OR REMOVE SCOPES**.
🖱️ In the search box type: `drive`
🖱️ Tick the one that says **`.../auth/drive`** — its description mentions *"See, edit, delete"* —
that's the full Drive access DriveThrough needs to store and share your files.
🖱️ Click **UPDATE**, then **SAVE AND CONTINUE**.

### Step 7 — Add yourself as a tester (important!)
🖱️ Click **ADD USERS**.
⌨️ Type your Gmail address → press Enter → click **ADD**.
🖱️ Click **SAVE AND CONTINUE**, then scroll down and click **BACK TO DASHBOARD**.

### ✅ Checkpoint 3
The dashboard shows your app `DriveThrough`, status **Testing**.
That's perfect — in Testing mode only people you listed can use it, which is exactly you.

> ℹ️ You do **NOT** need to "publish" or verify the app with Google. Personal use = Testing mode forever. ✔️

---

# ✅ Phase 4 — Create the keys (2 min) — the important part

### Step 8 — Open the credentials page
🌐 Open: **https://console.cloud.google.com/apis/credentials**
🖱️ Click **+ CREATE CREDENTIALS** (top bar) → **OAuth client ID**.

### Step 9 — Describe the app
| Field | Choose/type |
|---|---|
| Application type | **Web application** |
| Name | `drivethrough-web` |

### Step 10 — Add the return address (⚠️ copy-paste exactly)
This tells Google: "only send people back to THIS address" — a safety feature.

🖱️ Find **Authorized redirect URIs** → click **+ ADD URI**.
📋 **Paste this exactly** (use the Copy button at DriveThrough Settings later if unsure):

```
https://drivethrough-kek7.vercel.app/api/accounts/google/callback
```

> ⚠️ Must have **https**, the word **kek7**, and **no trailing slash** at the end.
> (Leave "Authorized JavaScript origins" empty — we don't need it.)

### Step 11 — Get your keys 🎁
🖱️ Click **CREATE**.
👀 A popup titled **"OAuth client created"** shows two strings.

### 🚨 Do this NOW — the secret is shown only ONCE:
📋 Copy **Client ID** → paste into your notes file.
📋 Copy **Client secret** → paste into your notes file.
🖱️ Click **OK** / **DOWNLOAD JSON** (your choice) to close.

> 🤫 Treat the **client secret** like a password. If you lose it: go back to
> Credentials → click the client name → delete it → repeat Steps 8–11 (2 min).

### ✅ Checkpoint 4
The Credentials page now lists one row: `drivethrough-web` · type *Web client*.
You have **two strings saved in your notes**.

---

# ✅ Phase 5 — Paste the keys into DriveThrough (1 min)

### Step 12 — Open DriveThrough Settings
🌐 Open: **https://drivethrough-navy.vercel.app/settings**
(Sign in first if asked.)
👀 You'll see a card titled **"Google Drive API credentials"** with status **Not configured**.

### Step 13 — Fill the card

| Field | What to put |
|---|---|
| **Client ID** | paste from your notes |
| **Client secret** | paste from your notes |
| **Redirect URI** | already pre-filled ✔️ — if not, paste the same URL from Step 10 |

🖱️ Click **Save credentials**.
👀 The status flips to **🟢 Configured**, and the secret field now reads
*"•••••• (saved — leave blank to keep)"* — that's security working: **nobody can read it back**.

### ✅ Checkpoint 5
Status chip = **Configured**, and the big orange **Connect Google Drive** button is no longer greyed out.

---

# ✅ Phase 6 — Connect your Drive 🎉 (1 min)

### Step 14 — The moment of truth
🖱️ Click **Connect Google Drive**.
👀 Your browser goes to **Google's own page** — account picker.
🖱️ Pick the account you want to connect.
🖱️ You'll see *"Google hasn't verified this app"* — click **Advanced** →
**Go to DriveThrough (unsafe)**. *(Safe: it's YOUR app; "unverified" just means you skipped
Google's paid verification review, which personal apps never need.)*
🖱️ Click **Allow**.

### ✅ Final checkpoint 🎊
You land back on **Settings** with a green banner *"Drive connected — quota synced."*
and a new **account card** showing your email + a quota bar.
Your Drive is now pooled into DriveThrough.

---

# 🆘 Something broke? Find your exact message here

| You see… | What happened | Fix |
|---|---|---|
| Greyed-out button / "isn't configured" | Keys not saved yet | Finish Phase 5 |
| Google page: **`redirect_uri_mismatch`** | The address in GCP differs from ours (often a typo or trailing `/`) | GCP → Credentials → click `drivethrough-web` → edit the redirect URI to match Step 10 exactly → Save. **No need to re-paste keys.** |
| Google page: **`invalid_client`** | Wrong keys, or the client was deleted | Re-copy ID+secret from GCP → re-save in Settings |
| "Access blocked" / "app isn't verified" | Normal for Testing-mode apps | Click **Advanced → Go to DriveThrough**. Still blocked? You're missing from Test users (Step 7) |
| Console page won't load / certificate error | Your network intercepts Google | Use your phone's **hotspot** and redo the phases |
| Accidentally closed the secret popup | Google shows it only once | Delete the client in GCP → repeat Steps 8–11 |
| 500/503 when clicking Connect before Phase 5 | Expected — no keys existed | Save keys first, then connect |
| Connected but quota shows "—" | First sync still running | Click **Sync** on the account card, or wait ~30 s and refresh |

---

# 📖 Mini-glossary (for the curious)

| Term | Meaning |
|---|---|
| **Google Cloud project** | A free folder at Google that owns your app's settings & keys |
| **OAuth consent screen** | The page where *you* approve what an app may access |
| **Client ID / Secret** | Your app's name tag / password at Google (Phases 4–5) |
| **Redirect URI** | The exact address Google may send you back to after approving |
| **Testing mode** | Only users you listed can consent — perfect for personal apps |
| **Encrypted at rest** | DriveThrough scrambles the secret (AES-256-GCM) in its database; only the server can unscramble it |

---

*Maintenance note: values live in DriveThrough's Settings (9Drive-parity in-app config);
`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` env vars are only a local-dev fallback.*
