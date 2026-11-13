import test from "node:test";
import assert from "node:assert/strict";
import {
  availableTimelineMonths,
  availableTimelineYears,
  formatFileSize,
  timelineDayKey,
  timelineMonthKey,
  filterPhotosByTimelineDate,
  mediaTimelineDate,
  sortPhotosByMediaDate,
  totalFileSize,
  whatsappFilenameCaptureDate
} from "../public/timeline-dates.js";

test("groups UTC timestamps by their India Standard Time date", () => {
  assert.equal(timelineDayKey("2026-08-30T18:29:59.000Z"), "2026-08-30");
  assert.equal(timelineDayKey("2026-08-30T18:30:00.000Z"), "2026-08-31");
  assert.equal(timelineMonthKey("2026-08-30T18:30:00.000Z"), "2026-08");
});

test("keeps unavailable dates in the unknown group", () => {
  assert.equal(timelineDayKey(null), "unknown");
  assert.equal(timelineMonthKey("not a date"), "unknown");
});

test("uses a WhatsApp media filename date as an India-local capture date", () => {
  const date = whatsappFilenameCaptureDate("VID-20260831-WA0015.mp4");
  assert.equal(date, "2026-08-31T06:30:00.000Z");
  assert.equal(timelineDayKey(date), "2026-08-31");
});

test("rejects invalid and non-WhatsApp filename dates", () => {
  assert.equal(whatsappFilenameCaptureDate("VID-20260230-WA0015.mp4"), null);
  assert.equal(whatsappFilenameCaptureDate("VID-20260831.mp4"), null);
});

test("sorts all media together by capture instant and puts unknown dates last", () => {
  const photos = [
    { name: "video.mp4", mimeType: "video/mp4", capturedAt: "2026-08-31T04:30:01.000Z" },
    { name: "unknown.jpg", mimeType: "image/jpeg", capturedAt: null },
    { name: "photo.jpg", mimeType: "image/jpeg", capturedAt: "2026-08-31T04:30:02.000Z" }
  ];
  assert.deepEqual(sortPhotosByMediaDate(photos).map(photo => photo.name), [
    "photo.jpg",
    "video.mp4",
    "unknown.jpg"
  ]);
  assert.equal(photos[0].name, "video.mp4");
});

test("keeps filename dates after exact capture times on the same day", () => {
  const sorted = sortPhotosByMediaDate([
    { name: "date-only.mp4", capturedAt: "2026-08-31T06:30:00.000Z", captureDateSource: "filename" },
    { name: "early.jpg", capturedAt: "2026-08-31T04:30:00.000Z", captureDateSource: "embedded" },
    { name: "late.jpg", capturedAt: "2026-08-31T05:30:00.000Z", captureDateSource: "embedded" }
  ]);
  assert.deepEqual(sorted.map(photo => photo.name), ["late.jpg", "early.jpg", "date-only.mp4"]);
});

test("prefers capture time, then modified time, then creation time", () => {
  const photos = [
    {
      name: "capture-date.jpg",
      captureDateSource: "embedded",
      capturedAt: "2026-08-31T10:00:00.000Z",
      modifiedTime: "2024-01-01T10:00:00.000Z",
      driveCreatedAt: "2023-01-01T10:00:00.000Z"
    },
    {
      name: "drive-capture-date.jpg",
      captureDateSource: "drive-capture",
      capturedAt: "2025-02-01T10:00:00.000Z",
      driveCreatedAt: "2024-12-01T10:00:00.000Z"
    },
    {
      name: "modified-date.jpg",
      captureDateSource: "drive-created",
      capturedAt: "2022-01-01T10:00:00.000Z",
      modifiedTime: "2024-03-01T10:00:00.000Z",
      driveCreatedAt: "2024-01-01T10:00:00.000Z"
    },
    { name: "creation-date.jpg", driveCreatedAt: "2023-03-01T10:00:00.000Z" }
  ];

  const sorted = sortPhotosByMediaDate(photos);
  assert.deepEqual(sorted.map(photo => photo.name), [
    "capture-date.jpg",
    "drive-capture-date.jpg",
    "modified-date.jpg",
    "creation-date.jpg"
  ]);
  assert.equal(mediaTimelineDate(sorted[0]), "2026-08-31T10:00:00.000Z");
  assert.equal(mediaTimelineDate(sorted[2]), "2024-03-01T10:00:00.000Z");
});

test("filters media by India-local month or year", () => {
  const photos = [
    { name: "august-late.jpg", capturedAt: "2026-08-30T18:30:00.000Z", captureDateSource: "embedded" },
    { name: "august-early.jpg", capturedAt: "2026-08-01T00:00:00.000Z", captureDateSource: "embedded" },
    { name: "july.jpg", capturedAt: "2026-07-31T18:29:59.000Z", captureDateSource: "embedded" },
    { name: "unknown.jpg", capturedAt: null }
  ];

  assert.deepEqual(filterPhotosByTimelineDate(photos, "month", "2026-08").map(photo => photo.name), [
    "august-late.jpg",
    "august-early.jpg"
  ]);
  assert.deepEqual(filterPhotosByTimelineDate(photos, "year", "2026").map(photo => photo.name), [
    "august-late.jpg",
    "august-early.jpg",
    "july.jpg"
  ]);
});

test("lists only months and years present in the full photo collection", () => {
  const photos = [
    { name: "november.jpg", capturedAt: "2026-11-13T10:00:00.000Z", captureDateSource: "embedded" },
    { name: "august.jpg", capturedAt: "2026-08-31T10:00:00.000Z", captureDateSource: "embedded" },
    { name: "last-year.jpg", capturedAt: "2025-12-01T10:00:00.000Z", captureDateSource: "embedded" },
    { name: "unknown.jpg", capturedAt: null }
  ];

  assert.deepEqual(availableTimelineMonths(photos), ["2026-11", "2026-08", "2025-12"]);
  assert.deepEqual(availableTimelineYears(photos), ["2026", "2025"]);
});

test("formats file sizes with readable binary units", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(10 * 1024 * 1024), "10 MB");
  assert.equal(formatFileSize(null), "Size unavailable");
});

test("sums the size of all media and rejects incomplete totals", () => {
  assert.equal(totalFileSize([{ sizeBytes: "1024" }, { sizeBytes: 2048 }]), 3072);
  assert.equal(totalFileSize([{ sizeBytes: "1024" }, { sizeBytes: null }]), null);
});
