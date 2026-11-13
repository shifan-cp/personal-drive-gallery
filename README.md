# Personal Drive Gallery

A private, date-sorted gallery for photos and videos stored in Google Drive. Visitors sign in with Google; access is limited to verified Gmail accounts approved by an administrator.

> **Privacy first:** Keep the Drive folder private. Share it only with the Worker service account, and never commit credentials or `.dev.vars`.

## What it does

| Gallery | Access | Storage |
| --- | --- | --- |
| Combines photos and videos in a chronological timeline, grouped by date in India Standard Time. | Google OAuth sign-in, a Gmail allowlist, and administrator-managed access. | Originals stay in Drive; Cloudflare D1 stores approved viewers and likes. |

- Resolves capture dates from Drive metadata, photo EXIF, video metadata, and supported WhatsApp filenames.
- Streams media through authenticated Worker endpoints; supports downloads and bounded byte-range requests.
- Lets viewers like media. Administrator likes also add items to the shared Favourites album.
- Refreshes the Drive folder tree while open and checks for new uploads every five minutes.

## Requirements

- Node.js LTS
- A Cloudflare account with Workers and D1
- A Google Cloud project with the Google Drive API and an OAuth web client

## Get started

### 1. Install dependencies

From the project directory:

```powershell
npm.cmd install
```

The `.cmd` launchers work in Windows PowerShell even when script execution is restricted.

### 2. Configure Google

1. Enable the **Google Drive API** in Google Cloud.
2. Create a service account and a JSON key. Share only the gallery folder with the service account's `client_email` as **Viewer**.
3. Create an OAuth client with type **Web application**. Add these redirect URIs:
   - Local: `http://localhost:8787/auth/callback`
   - Production: `https://YOUR-WORKER-DOMAIN/auth/callback`
4. Keep the OAuth client secret and service-account key private. Replace the production placeholder with your Worker hostname, and keep the OAuth redirect URI in sync if that hostname changes.

If the OAuth consent screen is in Testing, add the administrators and intended testers as test users.

### 3. Set up Cloudflare D1

Log in and create the database if it does not already exist:

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create personal-drive-gallery-access
```

If it already exists, find its ID with `npx.cmd wrangler d1 list`. Set `database_id` in `wrangler.jsonc` to that ID, then apply the migrations:

```powershell
npx.cmd wrangler d1 migrations apply personal-drive-gallery-access --local
npx.cmd wrangler d1 migrations apply personal-drive-gallery-access --remote
```

The migrations create the viewer allowlist and per-viewer media likes tables.

### 4. Add local credentials

Create `.dev.vars` in the project root. This file is ignored by Git.

```dotenv
GOOGLE_CLIENT_ID="your-oauth-client-id"
GOOGLE_CLIENT_SECRET="your-oauth-client-secret"
ADMIN_EMAILS="admin-one@gmail.com,admin-two@gmail.com"
SESSION_SECRET="a-long-random-secret"
DRIVE_FOLDER_ID="your-drive-gallery-folder-id"
SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n","client_email":"gallery-reader@your-project.iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token"}'
```

Use the full service-account JSON on one line, keeping the private key's escaped `\n` sequences. Use your own administrator Gmail addresses and Drive folder ID. Do not paste real credentials into source files, Git, or chat.

Generate a session secret locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 5. Run locally

```powershell
npm.cmd run dev
```

Open the Wrangler URL (usually `http://localhost:8787`) and sign in with an administrator account. Use **Manage access** to approve a viewer, then verify both approved and unapproved sign-in behavior.

Run the test suite with:

```powershell
npm.cmd test
```

## Deploy

Before deploying, confirm `wrangler.jsonc` has the correct D1 database ID and the remote migrations have succeeded. Set each production secret in the terminal; Wrangler prompts for its value:

```powershell
npx.cmd wrangler secret put GOOGLE_CLIENT_ID
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET
npx.cmd wrangler secret put ADMIN_EMAILS
npx.cmd wrangler secret put SESSION_SECRET
npx.cmd wrangler secret put DRIVE_FOLDER_ID
npx.cmd wrangler secret put SERVICE_ACCOUNT_JSON
```

Deploy:

```powershell
npm.cmd run deploy
```

Test production in a private browser window: administrator sign-in, approved and denied viewers, sign-out, and media access after revoking a viewer. The Google OAuth consent screen must permit the intended users.

The old `LOGIN_USERNAME` and `PASSWORD_HASH` secrets are no longer used. Once the new sign-in flow is verified, remove them if they remain:

```powershell
npx.cmd wrangler secret delete LOGIN_USERNAME
npx.cmd wrangler secret delete PASSWORD_HASH
```

## Privacy and troubleshooting

- The Drive folder should remain private. Do not change its general access to **Anyone**.
- The gallery URL is not a secret; access is enforced by Google sign-in and the allowlist. The Worker checks authorization for gallery, media, and thumbnail requests.
- Sessions use a signed, HttpOnly cookie. Thumbnails use a one-hour private browser cache, so a copy may remain on that device until it expires.
- Only verified `@gmail.com` accounts can sign in. Administrators manage viewer access in **Manage access**; do not add viewers directly to D1.
- This is a functional starter, not a security-audited production release. Protect the Cloudflare account with MFA and test authorization before sharing the gallery.

| Problem | Check |
| --- | --- |
| `redirect_uri_mismatch` | The OAuth redirect URI exactly matches the local or production hostname and `/auth/callback`. |
| Account is not authorized | An administrator has added that exact Gmail address in **Manage access**. |
| Viewer management says D1 is not configured | The `DB` binding and `database_id` in `wrangler.jsonc`, and the remote migrations. |
| Gallery is empty | The Drive API is enabled and the gallery folder is shared with the service account email. |
