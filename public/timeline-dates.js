const TIME_ZONE = "Asia/Kolkata";

function partsFor(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: values.year, month: values.month, day: values.day };
}

export function whatsappFilenameCaptureDate(name) {
  if (typeof name !== "string") return null;
  const match = name.match(/^(?:IMG|VID)-(\d{4})(\d{2})(\d{2})-WA\d+\.[a-z0-9]{2,5}$/i);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 6, 30));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date.toISOString();
}

export function mediaTimelineDate(photo) {
  const captureDateIsReliable = photo.captureDateSource !== "filename" &&
    photo.captureDateSource !== "drive-created";
  if (captureDateIsReliable && photo.capturedAt) return photo.capturedAt;
  return photo.modifiedTime || photo.driveCreatedAt || photo.capturedAt;
}

export function filterPhotosByTimelineDate(items, filterType, filterValue) {
  if (!filterValue || !["month", "year"].includes(filterType)) return items;
  return items.filter(photo => {
    const date = mediaTimelineDate(photo);
    if (!date) return false;
    const month = timelineMonthKey(date);
    return filterType === "month" ? month === filterValue : month.slice(0, 4) === filterValue;
  });
}

export function availableTimelineMonths(items) {
  return [...new Set(items
    .map(mediaTimelineDate)
    .filter(Boolean)
    .map(timelineMonthKey)
    .filter(month => month !== "unknown"))].sort().reverse();
}

export function availableTimelineYears(items) {
  return [...new Set(availableTimelineMonths(items).map(month => month.slice(0, 4)))].sort().reverse();
}

export function sortPhotosByMediaDate(items) {
  return [...items].sort((a, b) => {
    const aDate = mediaTimelineDate(a);
    const bDate = mediaTimelineDate(b);
    const aTime = Date.parse(aDate || "");
    const bTime = Date.parse(bDate || "");
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (!aValid) return bValid ? 1 : a.name.localeCompare(b.name);
    if (!bValid) return -1;
    const aDay = timelineDayKey(aDate);
    const bDay = timelineDayKey(bDate);
    if (aDay !== bDay) return bDay.localeCompare(aDay);
    const aTimeKnown = Boolean(a.driveCreatedAt) || a.captureDateSource !== "filename";
    const bTimeKnown = Boolean(b.driveCreatedAt) || b.captureDateSource !== "filename";
    if (aTimeKnown !== bTimeKnown) return aTimeKnown ? -1 : 1;
    if (!aTimeKnown) return a.name.localeCompare(b.name);
    return bTime - aTime || a.name.localeCompare(b.name);
  });
}

export function timelineMonthKey(value) {
  const parts = partsFor(value);
  return parts ? `${parts.year}-${parts.month}` : "unknown";
}

export function timelineDayKey(value) {
  const parts = partsFor(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : "unknown";
}

export function formatTimelineDate(value, options) {
  if (value === null || value === undefined || value === "") return "Date unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unknown";
  return date.toLocaleDateString(undefined, { ...options, timeZone: TIME_ZONE });
}

export function formatFileSize(value) {
  if (value === null || value === undefined || value === "") return "Size unavailable";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = bytes;
  let unitIndex = -1;
  do {
    size /= 1024;
    unitIndex++;
  } while (size >= 1024 && unitIndex < units.length - 1);
  return `${size.toFixed(1).replace(/\.0$/, "")} ${units[unitIndex]}`;
}

export function totalFileSize(items) {
  let total = 0;
  for (const item of items) {
    if (item.sizeBytes === null || item.sizeBytes === undefined || item.sizeBytes === "") return null;
    const bytes = Number(item.sizeBytes);
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    total += bytes;
  }
  return total;
}
