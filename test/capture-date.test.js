import test from "node:test";
import assert from "node:assert/strict";
import { captureDate, contentDispositionFilename } from "../src/worker.js";
import { parseExifCaptureDate, parseMediaDate, parseVideoCreationDate } from "../src/media-dates.js";

test("uses a valid Drive capture date before the creation date", () => {
  assert.equal(
    captureDate({
      imageMediaMetadata: { time: "2018:07:04 09:08:07" },
      createdTime: "2025-01-02T03:04:05.000Z"
    }),
    "2018-07-04T03:38:07.000Z"
  );
});

test("falls back to the Drive creation date when capture metadata is invalid", () => {
  assert.equal(
    captureDate({
      imageMediaMetadata: { time: "not a date" },
      createdTime: "2025-01-02T03:04:05.000Z"
    }),
    "2025-01-02T03:04:05.000Z"
  );
});

test("uses creation date when capture metadata is absent", () => {
  assert.equal(
    captureDate({ createdTime: "2025-01-02T03:04:05.000Z" }),
    "2025-01-02T03:04:05.000Z"
  );
});

test("returns no date when neither Drive date is usable", () => {
  assert.equal(captureDate({ createdTime: "not a date" }), null);
});

test("formats safe attachment filenames for media downloads", () => {
  const disposition = contentDispositionFilename('family "video".mp4');
  assert.equal(
    disposition,
    `attachment; filename="family _video_.mp4"; filename*=UTF-8''family%20%22video%22.mp4`
  );
  assert.doesNotMatch(disposition, /[\r\n]/);
});

test("interprets an EXIF local capture time as India Standard Time", () => {
  assert.equal(parseMediaDate("2026:08:31 00:15:00"), "2026-08-30T18:45:00.000Z");
});

test("uses EXIF offset metadata when it is present", () => {
  assert.equal(parseExifCaptureDate({
    DateTimeOriginal: "2026:08:31 10:00:00",
    OffsetTimeOriginal: "+05:30"
  }), "2026-08-31T04:30:00.000Z");
});

test("uses the embedded video creation date and ignores the MP4 zero date", () => {
  assert.equal(parseVideoCreationDate({
    created: "1904-01-01T00:00:00.000Z",
    tracks: [{ created: "2026-08-31T04:30:00.000Z" }]
  }), "2026-08-31T04:30:00.000Z");
  assert.equal(parseVideoCreationDate({ created: "1904-01-01T00:00:00.000Z" }), null);
});
