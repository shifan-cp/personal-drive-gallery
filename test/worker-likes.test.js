import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const SESSION_SECRET = "test-session-secret";
const ADMIN_EMAILS = "admin@gmail.com";
const APPROVED_VIEWERS = ["viewer-one@gmail.com", "viewer-two@gmail.com"];

async function sessionCookie(email) {
  const body = Buffer.from(JSON.stringify({
    sub: "gallery",
    email,
    googleSub: `google-${email}`,
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

function testEnvironment() {
  const likes = new Map();
  const viewers = new Set(APPROVED_VIEWERS);
  const DB = {
    prepare(sql) {
      let params = [];
      return {
        bind(...values) {
          params = values;
          return this;
        },
        async first() {
          if (sql.includes("allowed_viewers")) {
            return viewers.has(params[0]) ? { email: params[0] } : null;
          }
          const [fileId, userId] = params;
          const fileLikes = [...likes.values()].filter(like => like.fileId === fileId);
          return {
            likeCount: fileLikes.length,
            isFavorite: fileLikes.some(like => like.isAdmin) ? 1 : 0,
            likedByMe: fileLikes.some(like => like.userId === userId) ? 1 : 0
          };
        },
        async all() {
          const [userId] = params;
          const byFile = new Map();
          for (const like of likes.values()) {
            if (!byFile.has(like.fileId)) byFile.set(like.fileId, []);
            byFile.get(like.fileId).push(like);
          }
          return {
            results: [...byFile.entries()].map(([fileId, fileLikes]) => ({
              fileId,
              likeCount: fileLikes.length,
              isFavorite: fileLikes.some(like => like.isAdmin) ? 1 : 0,
              likedByMe: fileLikes.some(like => like.userId === userId) ? 1 : 0
            }))
          };
        },
        async run() {
          if (sql.includes("INSERT INTO media_likes")) {
            const [fileId, userId, isAdmin] = params;
            likes.set(`${fileId}:${userId}`, { fileId, userId, isAdmin: Boolean(isAdmin) });
          } else if (sql.includes("DELETE FROM media_likes")) {
            likes.delete(`${params[0]}:${params[1]}`);
          }
          return { success: true };
        }
      };
    }
  };
  return { likes, env: { DB, SESSION_SECRET, ADMIN_EMAILS } };
}

async function call(path, { method = "GET", email, body } = {}, env) {
  const headers = new Headers();
  if (email) headers.set("Cookie", await sessionCookie(email));
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request(`https://gallery.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

test("likes are per viewer and only administrator likes add shared favourites", async () => {
  const { env } = testEnvironment();
  assert.equal((await call("/api/likes", {}, env)).status, 401);

  const viewerLike = await call("/api/likes/media_1", {
    method: "PUT",
    email: APPROVED_VIEWERS[0],
    body: { isAdmin: true }
  }, env);
  assert.equal(viewerLike.status, 200);
  assert.deepEqual(await viewerLike.json(), {
    fileId: "media_1",
    likeCount: 1,
    isFavorite: false,
    likedByMe: true
  });

  const repeatLike = await call("/api/likes/media_1", {
    method: "PUT",
    email: APPROVED_VIEWERS[0]
  }, env);
  assert.equal((await repeatLike.json()).likeCount, 1);

  const otherViewer = await call("/api/likes", { email: APPROVED_VIEWERS[1] }, env);
  assert.deepEqual(await otherViewer.json(), {
    likes: [{
      fileId: "media_1",
      likeCount: 1,
      isFavorite: false,
      likedByMe: false
    }]
  });

  const adminLike = await call("/api/likes/media_1", {
    method: "PUT",
    email: ADMIN_EMAILS
  }, env);
  assert.deepEqual(await adminLike.json(), {
    fileId: "media_1",
    likeCount: 2,
    isFavorite: true,
    likedByMe: true
  });

  const viewerUnlike = await call("/api/likes/media_1", {
    method: "DELETE",
    email: APPROVED_VIEWERS[0]
  }, env);
  assert.deepEqual(await viewerUnlike.json(), {
    fileId: "media_1",
    likeCount: 1,
    isFavorite: true,
    likedByMe: false
  });

  const adminUnlike = await call("/api/likes/media_1", {
    method: "DELETE",
    email: ADMIN_EMAILS
  }, env);
  assert.deepEqual(await adminUnlike.json(), {
    fileId: "media_1",
    likeCount: 0,
    isFavorite: false,
    likedByMe: false
  });
});
