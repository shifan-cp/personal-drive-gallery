# Personal Drive Gallery

A private, chronological image/video gallery. Original media remains in Google Drive. Visitors sign in with Google using an approved Gmail address; two fixed administrators manage the viewer allowlist.

## Important design notes

- Google sign-in authenticates viewers. Google Cloud OAuth is separate from the Google service account used by the Worker to read Drive.
- Only verified `@gmail.com` accounts can sign in. The two administrators are configured in `ADMIN_EMAILS`; they can add or revoke viewer addresses in the gallery's **Manage access** panel.
- Cloudflare D1 stores the viewer allowlist and media likes keyed by Google's private subject identifier. Approved viewers can see aggregate like counts; only administrator likes add an item to the shared, date-sorted Favourites album. The Worker checks authorization for gallery, media, and thumbnail requests. Thumbnails use a one-hour private browser cache, so a cached copy can remain on that device until it expires.
- The Drive folder should remain private. Share only the gallery folder with the service account email as Viewer. Do not change General access to “Anyone”.
- Sessions use a signed, HttpOnly cookie. The old shared username/password login has been removed.
- The gallery recursively scans the Drive folder tree on refresh and checks for new uploads every five minutes while open. Capture-date handling prefers Drive capture metadata, then reads embedded EXIF dates for photos or MP4 creation dates for videos when needed. It tries standard WhatsApp filename dates before falling back to Drive `createdTime`.
- Photos and videos are mixed in one newest-first capture-time sequence and displayed under year/month/day headings in India Standard Time. Exact times are shown when metadata provides them; date-only filename fallbacks are marked with unknown time. The app reads bounded byte ranges and caches resolved dates in each browser.
- This is a functional starter, not a security-audited production release. Protect the Cloudflare account with MFA and test the authorization flow before sharing the site.

## 1. Prerequisites

Install Node.js LTS, then open a terminal in this project directory:

```bash
npm.cmd install
```

The commands below use the `.cmd` launchers so they work in Windows PowerShell even when script execution is restricted.

You will need a Cloudflare account and a Google Cloud project.

## 2. Google Drive service account

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable **Google Drive API**.
3. Go to **IAM & Admin → Service Accounts** and create a service account, e.g. `gallery-reader`.
4. Create a JSON key and keep it private.
5. In Google Drive, share only the gallery folder with the service account's `client_email` as **Viewer**.
6. Copy the folder ID from the Drive folder URL.

Never share your entire Drive unless you intend to. The service-account key must not be committed to Git or shared in chat.

## 3. Google OAuth web client

1. In the same Google Cloud project, configure the OAuth consent screen. Add the two administrators and intended testers as test users if the app remains in Testing.
2. Create an OAuth client ID of type **Web application**.
3. Add these authorized redirect URIs:
   - Local development: `http://localhost:8787/auth/callback`
   - Production: `https://YOUR-WORKER-DOMAIN/auth/callback`
4. Save the OAuth **Client ID** and **Client secret** privately.

If the production Worker hostname changes, update the production redirect URI in Google Cloud and use the exact same host when signing in.

## 4. Create the Cloudflare D1 database

Log in to Cloudflare. If the database does not already exist, create it:

```bash
npx.cmd wrangler login
npx.cmd wrangler d1 create personal-drive-gallery-access
```

If Wrangler says the database already exists, list databases and use the UUID for `personal-drive-gallery-access`:

```bash
npx.cmd wrangler d1 list
```

The `database_id` in `wrangler.jsonc` must match that UUID. This checkout is already configured for the existing database.

Apply the schema locally and remotely:

```bash
npx.cmd wrangler d1 migrations apply personal-drive-gallery-access --local
npx.cmd wrangler d1 migrations apply personal-drive-gallery-access --remote
```

The migrations create the Gmail-only `allowed_viewers` table and the per-user `media_likes` table. Do not add viewer records manually; use the Admin panel.

## 5. Configure local secrets

Create `.dev.vars` in the project root (it is ignored by Git) with the following keys:

```dotenv
GOOGLE_CLIENT_ID="your-oauth-client-id"
GOOGLE_CLIENT_SECRET="your-oauth-client-secret"
ADMIN_EMAILS="admin-one@gmail.com,admin-two@gmail.com"
SESSION_SECRET="a-long-random-secret"
DRIVE_FOLDER_ID="your-drive-gallery-folder-id"
SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n","client_email":"gallery-reader@your-project.iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token"}'
```

Use the full service-account JSON on one line. Keep the escaped `\n` sequences in its private key. Do not include extra single quotes around the JSON when pasting it into `.dev.vars` or `wrangler secret put`; the Worker accepts raw JSON and also tolerates a single-quoted copy/paste, but the safest format is the plain JSON object with no outer quotes. Replace the example administrator addresses with your own; do not send any secret values in chat.

Generate a session secret locally with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 6. Run and test locally

```bash
npm.cmd run dev
```

Open the Wrangler URL, usually `http://localhost:8787`. Sign in with one of the configured administrator Gmail accounts. Use **Manage access** to approve another Gmail address, then test sign-in with that account. Also verify that an unapproved account is denied and that removing an approved viewer prevents their next gallery/media request.

Local development uses Wrangler's local D1 database. If you have an older local Wrangler database from before the migration, apply migrations again with the command above.

## 7. Configure production and deploy

Before deploying, confirm `wrangler.jsonc` contains the real D1 database ID and the remote migration has succeeded. Then set the production secrets (values are entered into the terminal, not chat):

```bash
npx.cmd wrangler secret put GOOGLE_CLIENT_ID
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET
npx.cmd wrangler secret put ADMIN_EMAILS
npx.cmd wrangler secret put SESSION_SECRET
npx.cmd wrangler secret put DRIVE_FOLDER_ID
npx.cmd wrangler secret put SERVICE_ACCOUNT_JSON
```

Set `ADMIN_EMAILS` to:

```text
admin-one@gmail.com,admin-two@gmail.com
```

Deploy after the OAuth client, D1 database, migration, and all secrets are ready:

```bash
npm.cmd run deploy
```

Open the production URL in a private/incognito window and test administrator sign-in, a permitted viewer, a denied Gmail account, sign-out, and media access after revoking a viewer. The Google OAuth consent screen must allow the intended users (as test users while the app is in Testing).

The former `LOGIN_USERNAME` and `PASSWORD_HASH` secrets are no longer used. After confirming the new sign-in works, remove the old secrets if they still exist:

```bash
npx.cmd wrangler secret delete LOGIN_USERNAME
npx.cmd wrangler secret delete PASSWORD_HASH
```

## 8. Privacy and troubleshooting

- Keep the Drive folder private and shared only with the service account.
- The gallery URL is not a secret; access is controlled by Google sign-in and the allowlist.
- Anyone with administrator access can grant or revoke viewer access. Only the two addresses in `ADMIN_EMAILS` are administrators.
- If Google reports `redirect_uri_mismatch`, make sure the callback URL in Google Cloud exactly matches the current local or production hostname and `/auth/callback`.
- If sign-in says an account is not authorized, an administrator must add that exact Gmail address in **Manage access**.
- If a viewer-management request reports that D1 is not configured, check the `DB` binding and verify the database ID in `wrangler.jsonc`.
- If the gallery is empty, check that Drive API is enabled and the exact gallery folder is shared with the service-account email.
- Original photos and videos remain in Drive; the site streams them through authenticated Worker endpoints and offers downloads.
- Consider Cloudflare rate limiting/WAF protections and audit access before distributing the link widely.
