import test from "node:test";
import assert from "node:assert/strict";
import { getMediaFileInGallery } from "../src/worker.js";

function mockDriveFiles(context, files) {
  const requests = [];
  context.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    requests.push(url);
    const fileId = decodeURIComponent(url.pathname.split("/").pop());
    const file = files[fileId];
    return file
      ? Response.json(file)
      : new Response(null, { status: 404 });
  });
  return requests;
}

test("validates a media file through its parent folders without listing the gallery", async context => {
  const requests = mockDriveFiles(context, {
    media: {
      id: "media",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      parents: ["nested"]
    },
    nested: {
      id: "nested",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["gallery"]
    }
  });

  const file = await getMediaFileInGallery("token", "gallery", "media");

  assert.equal(file.name, "photo.jpg");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => /\/files\/[^/]+$/.test(url.pathname)));
});

test("rejects trashed, non-media, and out-of-gallery files", async context => {
  mockDriveFiles(context, {
    trashed: {
      id: "trashed",
      mimeType: "image/jpeg",
      parents: ["gallery"],
      trashed: true
    },
    folder: {
      id: "folder",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["gallery"]
    },
    outside: {
      id: "outside",
      mimeType: "video/mp4",
      parents: ["other"]
    },
    other: {
      id: "other",
      mimeType: "application/vnd.google-apps.folder",
      parents: []
    }
  });

  assert.equal(await getMediaFileInGallery("token", "gallery", "trashed"), null);
  assert.equal(await getMediaFileInGallery("token", "gallery", "folder"), null);
  assert.equal(await getMediaFileInGallery("token", "gallery", "outside"), null);
});
