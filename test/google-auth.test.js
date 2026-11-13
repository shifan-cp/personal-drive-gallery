import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT
} from "jose";
import {
  normalizeGmailAddress,
  parseAdminEmails,
  verifyGoogleIdToken
} from "../src/google-auth.js";

test("normalizes Gmail addresses and rejects other domains", () => {
  assert.equal(normalizeGmailAddress("  Family.Member@Gmail.com "), "family.member@gmail.com");
  assert.equal(normalizeGmailAddress("person@example.com"), null);
  assert.equal(normalizeGmailAddress("not-an-email"), null);
});

test("parses a comma- or whitespace-separated admin list", () => {
  assert.deepEqual(
    [...parseAdminEmails("ADMIN@gmail.com, second@gmail.com")],
    ["admin@gmail.com", "second@gmail.com"]
  );
  assert.throws(() => parseAdminEmails(""), /ADMIN_EMAILS/);
  assert.throws(() => parseAdminEmails("admin@example.com"), /ADMIN_EMAILS/);
});

test("verifies Google's signature, audience, nonce, and verified Gmail identity", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({
    email: "Family.Member@gmail.com",
    email_verified: true,
    nonce: "state-nonce"
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience("gallery-client")
    .setSubject("google-user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  assert.deepEqual(
    await verifyGoogleIdToken(token, "gallery-client", "state-nonce", jwks),
    { sub: "google-user-123", email: "family.member@gmail.com" }
  );
  await assert.rejects(verifyGoogleIdToken(token, "wrong-client", "state-nonce", jwks));
  await assert.rejects(verifyGoogleIdToken(token, "gallery-client", "wrong-nonce", jwks));
});

test("rejects unverified and non-Gmail Google identities", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({
    email: "person@example.com",
    email_verified: true,
    nonce: "state-nonce"
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("accounts.google.com")
    .setAudience("gallery-client")
    .setSubject("google-user-456")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  await assert.rejects(verifyGoogleIdToken(token, "gallery-client", "state-nonce", jwks));
});
