import exifr from "exifr";
import { createFile } from "mp4box";

const IST_OFFSET_MINUTES = 330;
const EXIF_DATE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

function parseOffsetMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes > 14 * 60) return null;
  return match[1] === "-" ? -minutes : minutes;
}

export function parseMediaDate(value, offsetValue) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const normalized = value.trim();
  const match = normalized.match(EXIF_DATE);
  if (match) {
    const [, yearText, monthText, dayText, hourText = "00", minuteText = "00", secondText = "00", fraction = ""] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const millisecond = Number((fraction + "000").slice(0, 3));
    const wallTime = new Date(0);
    wallTime.setUTCFullYear(year, month - 1, day);
    wallTime.setUTCHours(hour, minute, second, millisecond);
    if (
      wallTime.getUTCFullYear() !== year ||
      wallTime.getUTCMonth() !== month - 1 ||
      wallTime.getUTCDate() !== day ||
      wallTime.getUTCHours() !== hour ||
      wallTime.getUTCMinutes() !== minute ||
      wallTime.getUTCSeconds() !== second
    ) return null;
    const offsetMinutes = parseOffsetMinutes(offsetValue) ?? IST_OFFSET_MINUTES;
    return new Date(wallTime.getTime() - offsetMinutes * 60_000).toISOString();
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseDriveDate(value) {
  return parseMediaDate(value);
}

export function parseExifCaptureDate(metadata) {
  if (!metadata) return null;
  const candidates = [
    [metadata.DateTimeOriginal, metadata.OffsetTimeOriginal],
    [metadata.CreateDate, metadata.OffsetTimeDigitized],
    [metadata.DateTime, null]
  ];
  for (const [value, offset] of candidates) {
    const parsed = parseMediaDate(value, offset);
    if (parsed) return parsed;
  }
  return null;
}

export function parseVideoCreationDate(info) {
  const candidates = [info?.created, ...(info?.tracks || []).map(track => track.created)];
  for (const value of candidates) {
    const parsed = parseMediaDate(value);
    if (parsed && new Date(parsed).getUTCFullYear() > 1904) return parsed;
  }
  return null;
}

export async function readImageCaptureDate(buffer) {
  const metadata = await exifr.parse(buffer, {
    pick: ["DateTimeOriginal", "CreateDate", "DateTime", "OffsetTimeOriginal", "OffsetTimeDigitized"],
    reviveValues: false,
    gps: false,
    iptc: false,
    xmp: false
  });
  return parseExifCaptureDate(metadata);
}

export function readVideoCaptureDate(chunks) {
  const file = createFile();
  let info = null;
  let error = null;
  file.onReady = value => { info = value; };
  file.onError = value => { error = value; };
  for (const chunk of chunks) {
    const buffer = chunk.buffer.slice(0);
    buffer.fileStart = chunk.start;
    file.appendBuffer(buffer);
  }
  file.flush();
  return { capturedAt: parseVideoCreationDate(info), error };
}
