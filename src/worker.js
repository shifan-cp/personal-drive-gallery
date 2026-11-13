import {
  parseDriveDate,
  readImageCaptureDate,
  readVideoCaptureDate
} from "./media-dates.js";
import {
  normalizeGmailAddress,
  parseAdminEmails,
  verifyGoogleIdToken
} from "./google-auth.js";

const encoder = new TextEncoder();
let cachedDriveToken = null;
let cachedDriveTokenExpiresAt = 0;
const embeddedDateCache = new Map();
const MEDIA_DATE_BATCH_SIZE = 8;
const MEDIA_METADATA_RANGE_BYTES = 1024 * 1024;
const SESSION_COOKIE = "gallery_session";
const OAUTH_STATE_COOKIE = "gallery_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const OAUTH_STATE_MAX_AGE = 60 * 10;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

export function parseServiceAccountJson(value) {
  if (typeof value !== "string") throw new Error("SERVICE_ACCOUNT_JSON is not configured");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("SERVICE_ACCOUNT_JSON is empty");
  const candidate = (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ? trimmed.slice(1, -1)
    : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}
function b64url(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return result;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${b64url(signature)}`;
}
async function verifySignedPayload(token, secret) {
  if (typeof token !== "string" || !token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await hmacKey(secret);
    const sig = Uint8Array.from(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - parts[1].length % 4) % 4)), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(parts[0]));
    if (!valid) return null;
    const body = parts[0].replaceAll("-", "+").replaceAll("_", "/");
    const padded = body + "=".repeat((4 - body.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}
function cookieHeader(name, value, maxAge, request, sameSite = "Strict") {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${name}=${value}; Path=/; HttpOnly;${secure} SameSite=${sameSite}; Max-Age=${maxAge}`;
}
function corsHeaders(request) {
  // Same-origin deployment is recommended. No permissive CORS is enabled.
  return { "vary": "Origin" };
}
function pemToArrayBuffer(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function getDriveAccessToken(env) {
  if (cachedDriveToken && Date.now() < cachedDriveTokenExpiresAt - 60_000) return cachedDriveToken;
  let service;
  try { service = parseServiceAccountJson(env.SERVICE_ACCOUNT_JSON); }
  catch (error) {
    throw error;
  }
  if (!service.client_email || !service.private_key) throw new Error("Service account JSON is missing client_email/private_key");

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: service.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(service.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned)));
  const assertion = `${unsigned}.${b64url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Google token exchange failed (${response.status})`);
  cachedDriveToken = body.access_token;
  cachedDriveTokenExpiresAt = Date.now() + (body.expires_in || 3600) * 1000;
  return cachedDriveToken;
}

async function driveListPage(token, query, pageToken) {
  const params = new URLSearchParams({
    q: query,
    pageSize: "1000",
    fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,thumbnailLink,imageMediaMetadata(time,width,height),videoMediaMetadata(durationMillis,width,height))"
  });
  if (pageToken) params.set("pageToken", pageToken);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Drive list failed (${response.status})`);
  return response.json();
}
async function listGalleryFiles(env, token) {
  const folderId = env.DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("DRIVE_FOLDER_ID is not configured");
  const queue = [folderId];
  const seenFolders = new Set();
  const output = [];
  while (queue.length && seenFolders.size < 500) {
    const folder = queue.shift();
    if (seenFolders.has(folder)) continue;
    seenFolders.add(folder);
    let pageToken;
    do {
      const data = await driveListPage(token, `'${folder.replaceAll("'", "\\'")}' in parents and trashed = false`, pageToken);
      for (const file of (data.files || [])) {
        if (file.mimeType === "application/vnd.google-apps.folder") queue.push(file.id);
        else if (file.mimeType?.startsWith("image/") || file.mimeType?.startsWith("video/")) output.push(file);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  return output;
}
export function captureDate(file) {
  return parseDriveDate(file.imageMediaMetadata?.time) || parseDriveDate(file.createdTime);
}
function publicFile(file) {
  const driveCaptureDate = parseDriveDate(file.imageMediaMetadata?.time);
  const driveCreatedDate = parseDriveDate(file.createdTime);
  const needsEmbeddedDate = file.mimeType.startsWith("video/") || !driveCaptureDate;
  const capturedAt = driveCaptureDate || driveCreatedDate;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    capturedAt,
    driveCreatedAt: driveCreatedDate,
    modifiedTime: file.modifiedTime || "",
    sizeBytes: file.size || null,
    needsEmbeddedDate,
    captureDateSource: driveCaptureDate ? "drive-capture" : driveCreatedDate ? "drive-created" : "unknown",
    width: file.imageMediaMetadata?.width || file.videoMediaMetadata?.width || null,
    height: file.imageMediaMetadata?.height || file.videoMediaMetadata?.height || null,
    durationMillis: file.videoMediaMetadata?.durationMillis || null
  };
}
async function createMediaDateBatches(files, secret) {
  const pending = files.filter(file => {
    const hasDriveCaptureDate = Boolean(parseDriveDate(file.imageMediaMetadata?.time));
    return file.mimeType.startsWith("video/") || !hasDriveCaptureDate;
  });
  const batches = [];
  for (let index = 0; index < pending.length; index += MEDIA_DATE_BATCH_SIZE) {
    const batchFiles = pending.slice(index, index + MEDIA_DATE_BATCH_SIZE).map(file => ({
      id: file.id,
      mimeType: file.mimeType,
      size: Number(file.size) || 0,
      modifiedTime: file.modifiedTime || ""
    }));
    const token = await signSession({
      sub: "media-date-batch",
      files: batchFiles,
      exp: Math.floor(Date.now() / 1000) + 60 * 30
    }, secret);
    batches.push({ ids: batchFiles.map(file => file.id), token });
  }
  return batches;
}
async function readDriveRange(token, fileId, start, end) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: {
      authorization: `Bearer ${token}`,
      range: `bytes=${start}-${end}`
    }
  });
  if (response.status === 206) return response.arrayBuffer();
  if (response.ok) {
    await response.body?.cancel();
    return null;
  }
  throw new Error(`Drive metadata range fetch failed (${response.status})`);
}
async function resolveEmbeddedDate(file, token) {
  const cacheKey = `${file.id}:${file.modifiedTime}`;
  if (embeddedDateCache.has(cacheKey)) return embeddedDateCache.get(cacheKey);

  const size = file.size;
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const rangeLength = Math.min(size, MEDIA_METADATA_RANGE_BYTES);
  const first = await readDriveRange(token, file.id, 0, rangeLength - 1);
  if (!first) return null;

  let capturedAt = null;
  if (file.mimeType.startsWith("image/")) {
    try {
      capturedAt = await readImageCaptureDate(first);
    } catch (error) {
      console.warn("Could not parse embedded image date", file.id, error);
    }
  } else if (file.mimeType.startsWith("video/")) {
    const chunks = [{ buffer: first, start: 0 }];
    let result = { capturedAt: null, error: null };
    try {
      result = readVideoCaptureDate(chunks);
      capturedAt = result.capturedAt;
    } catch (error) {
      console.warn("Could not parse embedded video date", file.id, error);
    }
    if (!capturedAt && size > rangeLength) {
      const start = Math.max(rangeLength, size - MEDIA_METADATA_RANGE_BYTES);
      const tail = await readDriveRange(token, file.id, start, size - 1);
      if (tail) {
        try {
          result = readVideoCaptureDate([...chunks, { buffer: tail, start }]);
          capturedAt = result.capturedAt;
        } catch (error) {
          console.warn("Could not parse embedded video date", file.id, error);
        }
      }
    }
    if (!capturedAt && result.error) console.warn("Could not parse embedded video date", file.id, result.error);
  }

  if (embeddedDateCache.size >= 2000) {
    embeddedDateCache.delete(embeddedDateCache.keys().next().value);
  }
  embeddedDateCache.set(cacheKey, capturedAt);
  return capturedAt;
}
function redirectResponse(location, cookies = []) {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}
function loginRedirect(request, error, cookies = []) {
  const url = new URL("/", request.url);
  if (error) url.searchParams.set("error", error);
  return redirectResponse(`${url.pathname}${url.search}`, cookies);
}
function randomUrlToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
async function beginGoogleSignIn(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    return loginRedirect(request, "auth-not-configured");
  }
  const state = randomUrlToken();
  const nonce = randomUrlToken();
  const verifier = randomUrlToken() + randomUrlToken();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const stateToken = await signSession({
    sub: "google-oauth-state",
    state,
    nonce,
    verifier,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_MAX_AGE
  }, env.SESSION_SECRET);
  const callbackUrl = new URL("/auth/callback", request.url).toString();
  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  }).toString();
  return redirectResponse(authorizeUrl.toString(), [
    cookieHeader(OAUTH_STATE_COOKIE, stateToken, OAUTH_STATE_MAX_AGE, request, "Lax"),
    cookieHeader(SESSION_COOKIE, "", 0, request)
  ]);
}
async function finishGoogleSignIn(request, env) {
  const url = new URL(request.url);
  const clearStateCookie = cookieHeader(OAUTH_STATE_COOKIE, "", 0, request, "Lax");
  const clearSessionCookie = cookieHeader(SESSION_COOKIE, "", 0, request);
  if (url.searchParams.has("error")) return loginRedirect(request, "sign-in-cancelled", [clearStateCookie, clearSessionCookie]);

  const stateToken = parseCookies(request)[OAUTH_STATE_COOKIE];
  const statePayload = await verifySignedPayload(stateToken, env.SESSION_SECRET);
  if (
    !statePayload ||
    statePayload.sub !== "google-oauth-state" ||
    !url.searchParams.get("state") ||
    statePayload.state !== url.searchParams.get("state")
  ) return loginRedirect(request, "sign-in-failed", [clearStateCookie, clearSessionCookie]);

  const code = url.searchParams.get("code");
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return loginRedirect(request, "sign-in-failed", [clearStateCookie, clearSessionCookie]);
  }
  const callbackUrl = new URL("/auth/callback", request.url).toString();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
      code_verifier: statePayload.verifier
    })
  });
  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok || typeof tokens.id_token !== "string") {
    throw new Error(`Google token exchange failed (${tokenResponse.status})`);
  }
  const identity = await verifyGoogleIdToken(
    tokens.id_token,
    env.GOOGLE_CLIENT_ID,
    statePayload.nonce
  );
  const admins = parseAdminEmails(env.ADMIN_EMAILS);
  const isAdmin = admins.has(identity.email);
  if (!isAdmin) {
    if (!env.DB) throw new Error("D1 binding DB is not configured");
    const allowed = await env.DB.prepare(
      "SELECT email FROM allowed_viewers WHERE email = ?1"
    ).bind(identity.email).first();
    if (!allowed) return loginRedirect(request, "not-authorized", [clearStateCookie, clearSessionCookie]);
  }
  const session = await signSession({
    sub: "gallery",
    googleSub: identity.sub,
    email: identity.email,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  }, env.SESSION_SECRET);
  return redirectResponse("/", [
    cookieHeader(SESSION_COOKIE, session, SESSION_MAX_AGE, request),
    clearStateCookie
  ]);
}
async function getAuthenticatedUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  const payload = await verifySignedPayload(token, env.SESSION_SECRET);
  if (payload?.sub !== "gallery" || typeof payload.email !== "string") return null;
  const email = normalizeGmailAddress(payload.email);
  if (!email) return null;
  const userId = typeof payload.googleSub === "string" && payload.googleSub
    ? payload.googleSub
    : email;
  if (parseAdminEmails(env.ADMIN_EMAILS).has(email)) return { email, userId, isAdmin: true };
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  const allowed = await env.DB.prepare(
    "SELECT email FROM allowed_viewers WHERE email = ?1"
  ).bind(email).first();
  return allowed ? { email, userId, isAdmin: false } : null;
}
async function requireAdmin(request, env) {
  const user = await getAuthenticatedUser(request, env);
  return user?.isAdmin ? user : null;
}
function isAdminEmail(email, env) {
  return parseAdminEmails(env.ADMIN_EMAILS).has(email);
}
export function contentDispositionFilename(name) {
  const filename = String(name || "download");
  const fallback = filename.replace(/[^\x20-\x7E]|["\\/:*?<>|;]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
async function serveMedia(request, env, fileId, thumbnail = false, download = false) {
  const authenticated = await getAuthenticatedUser(request, env);
  if (!authenticated) return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Session" });

  const token = await getDriveAccessToken(env);
  // Ensure the requested ID belongs to the configured gallery folder tree.
  const files = await listGalleryFiles(env, token);
  const file = files.find(f => f.id === fileId);
  if (!file) return json({ error: "Not found" }, 404);

  let upstream;
  if (thumbnail) {
    const metadataUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=thumbnailLink,mimeType`;
    const metadataResponse = await fetch(metadataUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!metadataResponse.ok) return json({ error: "Unable to load thumbnail" }, 502);
    const metadata = await metadataResponse.json();
    if (!metadata.thumbnailLink) {
      // Fallback to the original file if Google has no thumbnail.
      upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { authorization: `Bearer ${token}` }
      });
    } else {
      upstream = await fetch(metadata.thumbnailLink, { headers: { authorization: `Bearer ${token}` } });
    }
  } else {
    const headers = {};
    const range = request.headers.get("Range");
    if (range) headers.Range = range;
    upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { authorization: `Bearer ${token}`, ...headers }
    });
  }
  if (!upstream.ok && upstream.status !== 206) return json({ error: "Unable to fetch media" }, 502);
  const headers = new Headers({
    "cache-control": thumbnail ? "private, max-age=3600" : "private, no-store",
    "x-content-type-options": "nosniff",
    "content-type": upstream.headers.get("content-type") || file.mimeType
  });
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (download && !thumbnail) headers.set("content-disposition", contentDispositionFilename(file.name));
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === "/auth/google" && request.method === "GET") {
        return await beginGoogleSignIn(request, env);
      }

      if (url.pathname === "/auth/callback" && request.method === "GET") {
        try {
          return await finishGoogleSignIn(request, env);
        } catch (error) {
          console.error("Google sign-in failed", error);
          const clearState = cookieHeader(OAUTH_STATE_COOKIE, "", 0, request, "Lax");
          const clearSession = cookieHeader(SESSION_COOKIE, "", 0, request);
          return loginRedirect(request, "sign-in-failed", [clearState, clearSession]);
        }
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        return json({ ok: true }, 200, {
          "set-cookie": cookieHeader(SESSION_COOKIE, "", 0, request)
        });
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        const user = await getAuthenticatedUser(request, env);
        return json({
          authenticated: Boolean(user),
          email: user?.email || null,
          isAdmin: Boolean(user?.isAdmin)
        });
      }

      if (url.pathname === "/api/admin/viewers") {
        const admin = await requireAdmin(request, env);
        if (!admin) return json({ error: "Unauthorized" }, 401);
        if (!env.DB) throw new Error("D1 binding DB is not configured");
        if (request.method === "GET") {
          const result = await env.DB.prepare(
            "SELECT email, added_by, created_at FROM allowed_viewers ORDER BY created_at DESC"
          ).all();
          return json({ admins: [...parseAdminEmails(env.ADMIN_EMAILS)], viewers: result.results || [] });
        }
        if (request.method === "POST") {
          let body;
          try { body = await request.json(); }
          catch { return json({ error: "Enter a valid Gmail address" }, 400); }
          const email = normalizeGmailAddress(body?.email);
          if (!email) return json({ error: "Only Gmail addresses can be added" }, 400);
          if (isAdminEmail(email, env)) return json({ error: "That address is already an administrator" }, 409);
          await env.DB.prepare(
            "INSERT INTO allowed_viewers (email, added_by) VALUES (?1, ?2) ON CONFLICT(email) DO NOTHING"
          ).bind(email, admin.email).run();
          return json({ ok: true, email });
        }
        if (request.method === "DELETE") {
          let body;
          try { body = await request.json(); }
          catch { return json({ error: "Select a valid Gmail address" }, 400); }
          const email = normalizeGmailAddress(body?.email);
          if (!email) return json({ error: "Only Gmail addresses can be removed" }, 400);
          if (isAdminEmail(email, env)) return json({ error: "Administrator access is managed separately" }, 409);
          await env.DB.prepare("DELETE FROM allowed_viewers WHERE email = ?1").bind(email).run();
          return json({ ok: true });
        }
        return json({ error: "Method not allowed" }, 405);
      }

      if (url.pathname === "/api/media-dates" && request.method === "POST") {
        if (!(await getAuthenticatedUser(request, env))) return json({ error: "Unauthorized" }, 401);
        let body;
        try { body = await request.json(); }
        catch { return json({ error: "Invalid media date batch" }, 400); }
        if (!body || typeof body !== "object" || !Array.isArray(body.ids) ||
            body.ids.length === 0 || body.ids.length > MEDIA_DATE_BATCH_SIZE ||
            body.ids.some(id => typeof id !== "string") || new Set(body.ids).size !== body.ids.length) {
          return json({ error: "Invalid media date batch" }, 400);
        }
        const payload = await verifySignedPayload(body.token, env.SESSION_SECRET);
        if (payload?.sub !== "media-date-batch" || !Array.isArray(payload.files)) {
          return json({ error: "Invalid or expired media date batch" }, 403);
        }
        const filesById = new Map(payload.files.map(file => [file.id, file]));
        const files = body.ids.map(id => filesById.get(id));
        if (files.some(file => !file)) return json({ error: "Media date batch contains an unauthorized file" }, 403);
        const driveToken = await getDriveAccessToken(env);
        const dates = await Promise.all(files.map(async file => ({
          id: file.id,
          capturedAt: await resolveEmbeddedDate(file, driveToken)
        })));
        return json({ dates });
      }

      if (url.pathname === "/api/photos" && request.method === "GET") {
        if (!(await getAuthenticatedUser(request, env))) return json({ error: "Unauthorized" }, 401);
        const token = await getDriveAccessToken(env);
        const files = await listGalleryFiles(env, token);
        const photos = files.map(publicFile).sort((a, b) => {
          const aDate = a.captureDateSource === "drive-capture"
            ? a.capturedAt || a.modifiedTime || a.driveCreatedAt
            : a.modifiedTime || a.driveCreatedAt || a.capturedAt;
          const bDate = b.captureDateSource === "drive-capture"
            ? b.capturedAt || b.modifiedTime || b.driveCreatedAt
            : b.modifiedTime || b.driveCreatedAt || b.capturedAt;
          if (!aDate) return bDate ? 1 : a.name.localeCompare(b.name);
          if (!bDate) return -1;
          return Date.parse(bDate) - Date.parse(aDate) || a.name.localeCompare(b.name);
        });
        const dateBatches = await createMediaDateBatches(files, env.SESSION_SECRET);
        return json({ photos, dateBatches });
      }

      if (url.pathname === "/api/likes" && request.method === "GET") {
        const user = await getAuthenticatedUser(request, env);
        if (!user) return json({ error: "Unauthorized" }, 401);
        if (!env.DB) throw new Error("D1 binding DB is not configured");
        const result = await env.DB.prepare(`
          SELECT
            file_id AS fileId,
            COUNT(*) AS likeCount,
            MAX(is_admin) AS isFavorite,
            MAX(CASE WHEN user_id = ?1 THEN 1 ELSE 0 END) AS likedByMe
          FROM media_likes
          GROUP BY file_id
        `).bind(user.userId).all();
        return json({
          likes: (result.results || []).map(like => ({
            fileId: like.fileId,
            likeCount: Number(like.likeCount),
            isFavorite: Boolean(like.isFavorite),
            likedByMe: Boolean(like.likedByMe)
          }))
        });
      }

      const likeMatch = url.pathname.match(/^\/api\/likes\/([a-zA-Z0-9_-]{1,256})$/);
      if (likeMatch) {
        const user = await getAuthenticatedUser(request, env);
        if (!user) return json({ error: "Unauthorized" }, 401);
        if (!env.DB) throw new Error("D1 binding DB is not configured");
        const fileId = likeMatch[1];
        if (request.method === "PUT") {
          await env.DB.prepare(`
            INSERT INTO media_likes (file_id, user_id, is_admin)
            VALUES (?1, ?2, ?3)
            ON CONFLICT (file_id, user_id) DO UPDATE SET is_admin = excluded.is_admin
          `).bind(fileId, user.userId, user.isAdmin ? 1 : 0).run();
        } else if (request.method === "DELETE") {
          await env.DB.prepare(
            "DELETE FROM media_likes WHERE file_id = ?1 AND user_id = ?2"
          ).bind(fileId, user.userId).run();
        } else {
          return json({ error: "Method not allowed" }, 405);
        }

        const like = await env.DB.prepare(`
          SELECT
            COUNT(*) AS likeCount,
            MAX(is_admin) AS isFavorite,
            MAX(CASE WHEN user_id = ?2 THEN 1 ELSE 0 END) AS likedByMe
          FROM media_likes
          WHERE file_id = ?1
        `).bind(fileId, user.userId).first();
        return json({
          fileId,
          likeCount: Number(like?.likeCount || 0),
          isFavorite: Boolean(like?.isFavorite),
          likedByMe: Boolean(like?.likedByMe)
        });
      }

      const mediaMatch = url.pathname.match(/^\/api\/(media|thumbnail)\/([a-zA-Z0-9_-]+)$/);
      if (mediaMatch && request.method === "GET") {
        return serveMedia(
          request,
          env,
          mediaMatch[2],
          mediaMatch[1] === "thumbnail",
          url.searchParams.get("download") === "1"
        );
      }

      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error. Check Worker logs and configuration." }, 500);
    }
  }
};
