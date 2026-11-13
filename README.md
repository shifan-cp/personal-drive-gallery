# Personal Drive Gallery

A private photo and video gallery that streams original media from Google Drive. Visitors sign in with Google and can view the gallery only when an administrator has approved their verified Gmail address.

## Contents

- [Features](#features)
- [Technology](#technology)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Deployment](#deployment)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Features

- Displays photos and videos together in chronological order, grouped by date in India Standard Time.
- Resolves capture dates from Drive metadata, photo EXIF, video metadata, and supported WhatsApp filenames.
- Uses Google OAuth and an administrator-managed Gmail allowlist.
- Streams media through authenticated endpoints and supports downloads and byte-range requests.
- Verifies media access against the configured Drive folder hierarchy without rescanning the entire gallery for each media request.
- Stores viewer access and likes in Cloudflare D1. Administrator likes also appear in shared Favourites.
- Refreshes the Drive folder tree while the gallery is open and checks for new uploads every five minutes.

## Technology

- Cloudflare Workers and D1
- Google Drive API and Google OAuth
- Node.js, Wrangler, and JavaScript modules

## Requirements

- Node.js LTS
- A Cloudflare account with Workers and D1
- A Google Cloud project with the Google Drive API enabled

## Getting started

Commands below use the Windows PowerShell `.cmd` launchers.

### 1. Install dependencies

```powershell
npm.cmd install
```

### 2. Configure Google

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Create a service account and a JSON key. Share only the gallery folder with the service account's `client_email` as **Viewer**.
3. Create an OAuth client with type **Web application**. Add these redirect URIs:
   - Local: `http://localhost:8787/auth/callback`
   - Production: `https://YOUR-WORKER-DOMAIN/auth/callback`
4. If the OAuth consent screen is in Testing, add administrators and intended testers as test users.

Replace `YOUR-WORKER-DOMAIN` with your Worker hostname. The OAuth redirect URI must match the hostname used to open the deployed gallery.

### 3. Configure Cloudflare D1

Log in to Cloudflare and create the database if it does not exist:

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create personal-drive-gallery-access
```

If the database already exists, find its ID with `npx.cmd wrangler d1 list`. Set `database_id` in `wrangler.jsonc` to that ID, then apply the migrations:

```powershell
npx.cmd wrangler d1 migrations apply personal-drive-gallery-access --local
npx.cmd wrangler d1 migrations apply personal-drive-gallery-access --remote
```

### 4. Configure local credentials

Create `.dev.vars` in the project root. It is ignored by Git.

```dotenv
GOOGLE_CLIENT_ID="your-oauth-client-id"
GOOGLE_CLIENT_SECRET="your-oauth-client-secret"
ADMIN_EMAILS="admin-one@gmail.com,admin-two@gmail.com"
SESSION_SECRET="a-long-random-secret"
DRIVE_FOLDER_ID="your-drive-gallery-folder-id"
SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n","client_email":"gallery-reader@your-project.iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token"}'
```

Use the full service-account JSON on one line and preserve the escaped `\n` sequences in its private key. Replace the example values with your own. Generate a session secret with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 5. Start the development server

```powershell
npm.cmd run dev
```

Open the Wrangler URL, usually `http://localhost:8787`. Sign in with an administrator account and use **Manage access** to approve a viewer.

### 6. Run tests

```powershell
npm.cmd test
```

## Deployment

Confirm `wrangler.jsonc` contains the correct D1 database ID and that the remote migrations have succeeded. Set production secrets from the terminal; Wrangler prompts for each value:

```powershell
npx.cmd wrangler secret put GOOGLE_CLIENT_ID
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET
npx.cmd wrangler secret put ADMIN_EMAILS
npx.cmd wrangler secret put SESSION_SECRET
npx.cmd wrangler secret put DRIVE_FOLDER_ID
npx.cmd wrangler secret put SERVICE_ACCOUNT_JSON
```

Deploy the Worker:

```powershell
npm.cmd run deploy
```

After deployment, test administrator sign-in, an approved viewer, a denied account, sign-out, and media access after revoking a viewer.

The former `LOGIN_USERNAME` and `PASSWORD_HASH` secrets are no longer used. After verifying the new sign-in flow, remove them if they remain:

```powershell
npx.cmd wrangler secret delete LOGIN_USERNAME
npx.cmd wrangler secret delete PASSWORD_HASH
```

## Security

- Keep the Drive folder private. Share it only with the service account; do not enable general access for **Anyone**.
- Never commit `.dev.vars`, OAuth credentials, or the service-account key.
- Only verified `@gmail.com` accounts can sign in. Manage access in the gallery rather than editing D1 directly.
- Sessions use a signed, HttpOnly cookie. The Worker checks authorization for gallery, media, and thumbnail requests.
- Thumbnails use a one-hour private browser cache and may remain on that device until the cache expires.
- This project is not a security-audited production release. Protect the Cloudflare account with MFA and test authorization before sharing the gallery.

## Troubleshooting

| Issue | Check |
| --- | --- |
| `redirect_uri_mismatch` | The OAuth redirect URI exactly matches the current hostname and `/auth/callback`. |
| Account is not authorized | An administrator has added that exact Gmail address in **Manage access**. |
| D1 is not configured | The `DB` binding, `database_id` in `wrangler.jsonc`, and remote migrations. |
| Gallery is empty | The Drive API is enabled and the gallery folder is shared with the service account email. |
