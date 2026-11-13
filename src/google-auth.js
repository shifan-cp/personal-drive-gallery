import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function normalizeGmailAddress(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@gmail\.com$/.test(email) ? email : null;
}

export function parseAdminEmails(value) {
  const entries = String(value || "").split(/[,\s]+/).filter(Boolean);
  const normalized = entries.map(normalizeGmailAddress);
  if (normalized.length === 0 || normalized.some(email => !email)) {
    throw new Error("ADMIN_EMAILS must contain one or more Gmail addresses");
  }
  return new Set(normalized);
}

export async function verifyGoogleIdToken(idToken, clientId, nonce, jwks = GOOGLE_JWKS) {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
    algorithms: ["RS256"],
    clockTolerance: 30
  });
  const email = normalizeGmailAddress(payload.email);
  if (
    typeof payload.sub !== "string" ||
    !email ||
    payload.email_verified !== true ||
    payload.nonce !== nonce
  ) {
    throw new Error("Google account is not eligible for this gallery");
  }
  return { sub: payload.sub, email };
}
