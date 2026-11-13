import test from "node:test";
import assert from "node:assert/strict";
import worker, { parseServiceAccountJson } from "../src/worker.js";

const SESSION_SECRET = "test-session-secret";
const ADMIN_EMAILS = "admin-one@gmail.com,admin-two@gmail.com";

async function sessionCookie(email) {
  const body = Buffer.from(JSON.stringify({
    sub: "gallery",
    email,
    exp: Math.floor(Date.now() / 1000) + 60
  })).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  ));
  return `gallery_session=${body}.${Buffer.from(signature).toString("base64url")}`;
}

function testEnvironment(initialViewers = []) {
  const viewers = new Map(initialViewers.map(email => [email, {
    email,
    added_by: "admin-one@gmail.com",
    created_at: "2026-01-01T00:00:00.000Z"
  }]));
  const DB = {
    prepare(sql) {
      let params = [];
      return {
        bind(...values) {
          params = values;
          return this;
        },
        async first() {
          const email = params[0];
          return viewers.get(email) || null;
        },
        async all() {
          return { results: [...viewers.values()] };
        },
        async run() {
          if (sql.startsWith("INSERT")) {
            const [email, addedBy] = params;
            if (!viewers.has(email)) viewers.set(email, {
              email,
              added_by: addedBy,
              created_at: "2026-01-01T00:00:00.000Z"
            });
          } else if (sql.startsWith("DELETE")) {
            viewers.delete(params[0]);
          }
          return { success: true };
        }
      };
    }
  };
  return {
    viewers,
    env: { DB, SESSION_SECRET, ADMIN_EMAILS }
  };
}

async function call(path, { method = "GET", cookie, body } = {}, env = testEnvironment().env) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request(`https://gallery.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

test("accepts a service-account JSON string wrapped in single quotes", () => {
  const json = '{"type":"service_account","client_email":"book@project.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n"}';
  assert.deepEqual(parseServiceAccountJson(`'${json}'`), JSON.parse(json));
  assert.deepEqual(parseServiceAccountJson(json), JSON.parse(json));
});

test("disables the old password route and protects gallery and media endpoints", async () => {
  const env = testEnvironment().env;
  assert.equal((await call("/api/login", { method: "POST", body: {} }, env)).status, 404);
  assert.equal((await call("/api/photos", {}, env)).status, 401);
  assert.equal((await call("/api/media/file-id", {}, env)).status, 401);
  assert.equal((await call("/api/thumbnail/file-id", {}, env)).status, 401);
  assert.equal((await call("/api/admin/viewers", {}, env)).status, 401);
});

test("admin can add Gmail viewers, rejects other domains, and revoke access immediately", async () => {
  const { env, viewers } = testEnvironment();
  const cookie = await sessionCookie("admin-one@gmail.com");

  const added = await call("/api/admin/viewers", {
    method: "POST",
    cookie,
    body: { email: "Family.Member@gmail.com" }
  }, env);
  assert.equal(added.status, 200);
  assert.equal((await added.json()).email, "family.member@gmail.com");
  assert.equal(viewers.has("family.member@gmail.com"), true);

  const invalid = await call("/api/admin/viewers", {
    method: "POST",
    cookie,
    body: { email: "person@example.com" }
  }, env);
  assert.equal(invalid.status, 400);

  const viewerCookie = await sessionCookie("family.member@gmail.com");
  assert.equal((await call("/api/me", { cookie: viewerCookie }, env)).status, 200);
  assert.equal((await call("/api/admin/viewers", { cookie: viewerCookie }, env)).status, 401);

  const removed = await call("/api/admin/viewers", {
    method: "DELETE",
    cookie,
    body: { email: "family.member@gmail.com" }
  }, env);
  assert.equal(removed.status, 200);
  assert.equal(viewers.has("family.member@gmail.com"), false);
  const revokedSession = await call("/api/me", { cookie: viewerCookie }, env);
  assert.equal(revokedSession.status, 200);
  assert.equal((await revokedSession.json()).authenticated, false);
  assert.equal((await call("/api/media/file-id", { cookie: viewerCookie }, env)).status, 401);
});

test("viewer cannot modify the allowlist and administrator access cannot be revoked there", async () => {
  const { env } = testEnvironment(["viewer@gmail.com"]);
  const viewerCookie = await sessionCookie("viewer@gmail.com");
  const adminCookie = await sessionCookie("admin-two@gmail.com");

  assert.equal((await call("/api/admin/viewers", {
    method: "DELETE",
    cookie: viewerCookie,
    body: { email: "viewer@gmail.com" }
  }, env)).status, 401);
  assert.equal((await call("/api/admin/viewers", {
    method: "DELETE",
    cookie: adminCookie,
    body: { email: "admin-one@gmail.com" }
  }, env)).status, 409);
});
