import {
  availableTimelineMonths,
  availableTimelineYears,
  formatFileSize,
  formatTimelineDate,
  filterPhotosByTimelineDate,
  mediaTimelineDate,
  sortPhotosByMediaDate,
  totalFileSize,
  timelineDayKey,
  timelineMonthKey,
  whatsappFilenameCaptureDate
} from "./timeline-dates.js";

const app = document.querySelector("#app");
const DATE_CACHE_KEY = "little-moments.capture-dates.v1";
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let photos = [];
let visiblePhotos = [];
let dateFilterType = "all";
const dateFilterValues = { month: "", year: "" };
let activeAlbum = "all";
let currentIndex = 0;
let dateScanFailureCount = 0;
let embeddedDateFallbackCount = 0;
let filenameDateFallbackCount = 0;
let galleryLoadInProgress = false;
let lastGalleryLoadAt = 0;
let galleryRefreshError = "";
let galleryUser = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function renderLogin(message = "") {
  app.innerHTML = `
    <main class="login-wrap">
      <section class="login-panel">
        <div class="login-story">
          <div class="brand-lockup">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="brand-caption">A PRIVATE FAMILY ALBUM</span>
          </div>
          <p class="eyebrow">THE LITTLE THINGS, KEPT CLOSE</p>
          <h1>Every day has<br />a little magic.</h1>
          <p class="login-intro">A quiet place for the smiles, milestones, and moments you’ll want to remember.</p>
        </div>
        <section class="login-card">
          <p class="eyebrow">WELCOME BACK</p>
          <h2>Come on in</h2>
          <p class="login-hint">Sign in with an approved Gmail account to view this private family album.</p>
          <a class="primary google-signin" href="/auth/google">Continue with Google <span aria-hidden="true">→</span></a>
          <div class="status" role="alert">${escapeHtml(message)}</div>
        </section>
      </section>
    </main>`;
}
function groupByMonth(items) {
  const groups = new Map();
  for (const photo of items) {
    const key = timelineMonthKey(mediaTimelineDate(photo));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(photo);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return b.localeCompare(a);
  });
}
function monthLabel(key) {
  if (key === "unknown") return "Date unknown";
  const [year, month] = key.split("-").map(Number);
  return formatTimelineDate(new Date(Date.UTC(year, month - 1, 15, 12)), { month:"long", year:"numeric" });
}
function dateLabel(value) {
  if (!value) return "Date unknown";
  return formatTimelineDate(value, { weekday:"short", month:"short", day:"numeric", year:"numeric" });
}
function dateTimeLabel(value) {
  if (!value) return "Time unknown";
  return formatTimelineDate(value, {
    weekday:"short",
    month:"short",
    day:"numeric",
    year:"numeric",
    hour:"numeric",
    minute:"2-digit"
  });
}
function photoTimeLabel(photo) {
  const date = mediaTimelineDate(photo);
  if (!date || (photo.captureDateSource === "filename" && date === photo.capturedAt &&
    !photo.modifiedTime && !photo.driveCreatedAt)) return "Time unknown";
  return formatTimelineDate(date, { hour:"numeric", minute:"2-digit" });
}
function photoDateTimeLabel(photo) {
  const date = mediaTimelineDate(photo);
  if (!date) return "Date and time unknown";
  if (photo.captureDateSource === "filename" && date === photo.capturedAt &&
    !photo.modifiedTime && !photo.driveCreatedAt) {
    return `${dateLabel(date)} · time unknown (from filename)`;
  }
  return dateTimeLabel(date);
}
function dayKey(photo) {
  return timelineDayKey(mediaTimelineDate(photo));
}
function mediaUrl(photo, thumbnail = false) {
  return `/api/${thumbnail ? "thumbnail" : "media"}/${encodeURIComponent(photo.id)}`;
}
function dateFilterMarkup() {
  const months = availableTimelineMonths(photos);
  const years = availableTimelineYears(photos);
  if (!months.includes(dateFilterValues.month)) dateFilterValues.month = "";
  if (!years.includes(dateFilterValues.year)) dateFilterValues.year = "";

  return `<div class="date-filter" role="group" aria-label="Filter by date">
    <label for="date-filter-type">Filter by</label>
    <select id="date-filter-type">
      <option value="all"${dateFilterType === "all" ? " selected" : ""}>All dates</option>
      <option value="month"${dateFilterType === "month" ? " selected" : ""}>Month</option>
      <option value="year"${dateFilterType === "year" ? " selected" : ""}>Year</option>
    </select>
    <label class="date-filter-control" for="date-filter-month"${dateFilterType === "month" ? "" : " hidden"}>
      <span>Month</span>
      <select id="date-filter-month">
        <option value="">Choose month</option>
        ${months.map(month => `<option value="${escapeHtml(month)}"${dateFilterValues.month === month ? " selected" : ""}>${escapeHtml(monthLabel(month))}</option>`).join("")}
      </select>
    </label>
    <label class="date-filter-control" for="date-filter-year"${dateFilterType === "year" ? "" : " hidden"}>
      <span>Year</span>
      <select id="date-filter-year">
        <option value="">Choose year</option>
        ${years.map(year => `<option value="${escapeHtml(year)}"${dateFilterValues.year === year ? " selected" : ""}>${escapeHtml(year)}</option>`).join("")}
      </select>
    </label>
  </div>`;
}
function renderTimelineContent() {
  const dateFilteredPhotos = filterPhotosByTimelineDate(
    photos,
    dateFilterType,
    dateFilterValues[dateFilterType] || ""
  );
  const filteredPhotos = activeAlbum === "favorites"
    ? dateFilteredPhotos.filter(photo => photo.isFavorite)
    : dateFilteredPhotos;
  const photoIndexById = new Map(filteredPhotos.map((photo, index) => [photo.id, index]));
  const groups = groupByMonth(filteredPhotos);
  const monthsHtml = groups.map(([key, monthPhotos]) => {
    const days = new Map();
    for (const p of monthPhotos) {
      const day = dayKey(p);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(p);
    }
    const dayHtml = [...days.entries()].sort((a,b) => b[0].localeCompare(a[0])).map(([day, dayPhotos]) => `
      <section class="day-group">
        <h3 class="day-title">${escapeHtml(day === "unknown" ? "Date unknown" : dateLabel(`${day}T12:00:00+05:30`))}</h3>
        <div class="grid">${dayPhotos.map(p => {
          const index = photoIndexById.get(p.id);
          const isVideo = p.mimeType.startsWith("video/");
          return `<div class="photo-card" data-photo-id="${escapeHtml(p.id)}">
            <div class="photo-visual">
              <button class="photo" data-index="${index}" aria-label="Open ${escapeHtml(p.name)}">
                <span class="thumb-wrap">
                  <img class="photo-thumbnail" src="${mediaUrl(p, true)}" alt="" loading="lazy" />
                  ${isVideo ? `<video class="hover-video-preview" src="${mediaUrl(p)}" poster="${mediaUrl(p, true)}" muted loop playsinline preload="none" aria-hidden="true"></video>` : ""}
                  ${isVideo ? '<span class="video-tag">▶ Video</span>' : ""}
                </span>
              </button>
            </div>
            <button class="photo-details" data-index="${index}" aria-label="Open ${escapeHtml(p.name)}">
              <span class="photo-name">${escapeHtml(p.name)}</span>
              <time class="photo-time"${mediaTimelineDate(p) ? ` datetime="${escapeHtml(mediaTimelineDate(p))}"` : ""}>${escapeHtml(photoTimeLabel(p))}</time>
              ${p.likeCount > 0 ? `<span class="photo-like-count" aria-label="${p.likeCount} likes"><span aria-hidden="true">♥</span> ${p.likeCount}</span>` : ""}
            </button>
          </div>`;
        }).join("")}</div>
      </section>`).join("");
    return `<section class="month"><h2>${escapeHtml(monthLabel(key))}</h2>${dayHtml}</section>`;
  }).join("");

  const galleryContent = document.querySelector("#gallery-content");
  if (!galleryContent) return;
  galleryContent.innerHTML = filteredPhotos.length
    ? monthsHtml
    : activeAlbum === "favorites"
    ? '<div class="empty">No favourites match this date filter yet.</div>'
    : photos.length
      ? '<div class="empty">No photos or videos match this date filter.</div>'
      : '<div class="empty">No images or videos were found in the connected Drive folder.</div>';
  const momentCount = document.querySelector("#moment-count");
  if (momentCount) {
    momentCount.textContent = `${filteredPhotos.length} ${filteredPhotos.length === 1 ? "moment" : "moments"}`;
  }
  const canHoverPreview = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  galleryContent.querySelectorAll(".photo, .photo-details").forEach(button => {
    const preview = button.querySelector(".hover-video-preview");
    if (canHoverPreview && preview) {
      button.addEventListener("mouseenter", () => {
        const playback = preview.play();
        playback.catch(error => {
          if (error.name !== "AbortError") console.warn("Could not play the thumbnail preview", error);
        });
      });
      button.addEventListener("mouseleave", () => {
        preview.pause();
        if (preview.readyState > 0) preview.currentTime = 0;
      });
    }
    button.addEventListener("click", () => {
      preview?.pause();
      openLightbox(Number(button.dataset.index), filteredPhotos);
    });
  });
}
function renderTimeline() {
  app.innerHTML = `<main class="shell">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"></span>
        <div><div class="brand">Little Moments</div><div class="brand-caption">A PRIVATE FAMILY ALBUM</div></div>
      </div>
      <div class="top-actions">
        ${galleryUser?.isAdmin ? '<button class="btn" id="manage-access">Manage access</button>' : ""}
        <button class="btn" id="refresh"><span aria-hidden="true">↻</span> Refresh</button>
        <button class="btn btn-quiet" id="logout">Sign out</button>
      </div>
    </header>
    <section class="welcome">
      <div class="welcome-copy">
        <p class="eyebrow">THE DAYS YOU’LL WANT TO KEEP</p>
        <h1>Moments to treasure,<br />all in one place.</h1>
        <p>Little smiles, big milestones, and everything in between.</p>
      </div>
      <div class="collection-stat">
        <span class="stat-number">${photos.length}</span>
        <span class="stat-label">photos &amp; videos<br />to look back on</span>
        <span class="stat-total">Total size: ${escapeHtml(formatFileSize(totalFileSize(photos)))}</span>
        <span class="stat-sparkle" aria-hidden="true">✳</span>
      </div>
    </section>
    <div class="timeline-heading">
      <div><p class="eyebrow">YOUR FAMILY STORY</p><h2>Memory lane</h2></div>
    </div>
    <nav class="album-tabs" aria-label="Media albums">
      <button class="album-tab" type="button" data-album="all" aria-current="page">All media</button>
      <button class="album-tab" type="button" data-album="favorites">Favourites</button>
    </nav>
    <div class="timeline-tools">
      ${dateFilterMarkup()}
      <p class="subtle" id="moment-count"></p>
    </div>
    <div id="gallery-content"></div>
    <footer class="gallery-footer">
      ${dateScanFailureCount ? `${dateScanFailureCount} items could not be checked for embedded dates. ` : ""}
      ${filenameDateFallbackCount ? `${filenameDateFallbackCount} items use dates from their WhatsApp filenames. ` : ""}
      ${embeddedDateFallbackCount ? `${embeddedDateFallbackCount} items have no readable capture date, so their Drive dates are shown. ` : ""}
      ${galleryRefreshError ? `${escapeHtml(galleryRefreshError)} ` : ""}
      Sorted by capture date and time in India Standard Time; all media types are mixed together.
    </footer>
  </main>`;

  const filterType = document.querySelector("#date-filter-type");
  const filterControls = {
    month: document.querySelector("#date-filter-month"),
    year: document.querySelector("#date-filter-year")
  };
  filterType.addEventListener("change", () => {
    dateFilterType = filterType.value;
    for (const [type, control] of Object.entries(filterControls)) {
      control.closest(".date-filter-control").hidden = type !== dateFilterType;
    }
    renderTimelineContent();
  });
  for (const [type, control] of Object.entries(filterControls)) {
    control.addEventListener("change", () => {
      dateFilterValues[type] = control.value;
      renderTimelineContent();
    });
  }
  document.querySelectorAll(".album-tab").forEach(button => {
    button.addEventListener("click", () => {
      activeAlbum = button.dataset.album;
      document.querySelectorAll(".album-tab").forEach(tab => {
        if (tab.dataset.album === activeAlbum) tab.setAttribute("aria-current", "page");
        else tab.removeAttribute("aria-current");
      });
      renderTimelineContent();
    });
  });
  renderTimelineContent();
  document.querySelector("#refresh").addEventListener("click", loadGallery);
  document.querySelector("#manage-access")?.addEventListener("click", showAdminPanel);
  document.querySelector("#logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method:"POST", body:"{}" }); }
    finally {
      galleryUser = null;
      renderLogin();
    }
  });
}
function showAdminPanel() {
  const overlay = document.createElement("div");
  overlay.className = "admin-overlay";
  document.body.appendChild(overlay);
  overlay.addEventListener("click", event => {
    if (event.target === overlay) overlay.remove();
  });

  async function render(message = "") {
    let data = { admins: [], viewers: [] };
    let loadError = "";
    try {
      data = await api("/api/admin/viewers");
    } catch (error) {
      loadError = error.message;
    }
    overlay.innerHTML = `
      <section class="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <header class="admin-heading">
          <div><p class="eyebrow">FAMILY ALBUM</p><h2 id="admin-title">Manage access</h2></div>
          <button class="btn btn-quiet" id="close-admin" type="button" aria-label="Close">Close ✕</button>
        </header>
        <p class="login-hint">Only approved Gmail accounts can view the gallery. Changes take effect on their next request.</p>
        <div class="status" role="alert">${escapeHtml(loadError || message)}</div>
        <form class="invite-form" id="invite-viewer">
          <label class="field" for="viewer-email">Approve a Gmail address
            <input id="viewer-email" name="email" type="email" placeholder="name@gmail.com" autocomplete="off" required />
          </label>
          <button class="primary" type="submit">Add viewer</button>
        </form>
        <section class="access-list"><h3>Administrators</h3><ul>
          ${data.admins.map(email => `<li>${escapeHtml(email)} <span class="subtle">Admin</span></li>`).join("") || "<li>None configured</li>"}
        </ul></section>
        <section class="access-list"><h3>Approved viewers</h3><ul>
          ${data.viewers.map(viewer => `<li><span>${escapeHtml(viewer.email)}</span><button class="btn btn-quiet remove-viewer" type="button" data-email="${escapeHtml(viewer.email)}">Remove</button></li>`).join("") || "<li>No viewers added yet</li>"}
        </ul></section>
      </section>`;

    overlay.querySelector("#close-admin").addEventListener("click", () => overlay.remove());
    const form = overlay.querySelector("#invite-viewer");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const email = new FormData(form).get("email");
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await api("/api/admin/viewers", { method: "POST", body: JSON.stringify({ email }) });
        await render("Viewer approved. They can now sign in with Google.");
      } catch (error) {
        await render(error.message);
      }
    });
    overlay.querySelectorAll(".remove-viewer").forEach(button => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("/api/admin/viewers", { method: "DELETE", body: JSON.stringify({ email: button.dataset.email }) });
        await render("Viewer access removed.");
      } catch (error) {
        await render(error.message);
      }
    }));
  }
  render();
}
function readCaptureDateCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || "{}");
    return cached && typeof cached === "object" && !Array.isArray(cached) ? cached : {};
  } catch (error) {
    console.warn("Could not read the local capture-date cache", error);
    return {};
  }
}
function writeCaptureDateCache(cache) {
  try {
    localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn("Could not save the local capture-date cache", error);
  }
}
function captureDateCacheKey(photo) {
  return `${photo.id}:${photo.modifiedTime || ""}`;
}
async function resolveEmbeddedDates(items, batches, showProgress = true) {
  const cache = readCaptureDateCache();
  const photoById = new Map(items.map(photo => [photo.id, photo]));
  const currentKeys = new Set();
  const pendingIds = new Set();
  for (const photo of items) {
    if (!photo.needsEmbeddedDate) continue;
    const key = captureDateCacheKey(photo);
    currentKeys.add(key);
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      const filenameDate = whatsappFilenameCaptureDate(photo.name);
      photo.capturedAt = cache[key] || filenameDate || photo.driveCreatedAt || null;
      photo.captureDateSource = cache[key] ? "embedded" : filenameDate ? "filename" : "drive-created";
    } else {
      pendingIds.add(photo.id);
    }
  }
  for (const key of Object.keys(cache)) {
    if (!currentKeys.has(key)) delete cache[key];
  }

  const queue = (batches || []).map(batch => ({
    token: batch.token,
    ids: batch.ids.filter(id => pendingIds.has(id))
  })).filter(batch => batch.ids.length);
  let scanned = 0;
  let failed = 0;
  if (queue.length) {
    const total = queue.reduce((count, batch) => count + batch.ids.length, 0);
    const renderProgress = () => {
      app.innerHTML = `<main class="shell"><div class="loading" aria-live="polite">Checking original capture dates: ${scanned} of ${total}…</div></main>`;
    };
    if (showProgress) renderProgress();
    async function scanQueue() {
      while (queue.length) {
        const batch = queue.shift();
        try {
          const result = await api("/api/media-dates", {
            method: "POST",
            body: JSON.stringify({ token: batch.token, ids: batch.ids })
          });
          for (const item of result.dates || []) {
            const photo = photoById.get(item.id);
            if (!photo) continue;
            const filenameDate = whatsappFilenameCaptureDate(photo.name);
            photo.capturedAt = item.capturedAt || filenameDate || photo.driveCreatedAt || null;
            photo.captureDateSource = item.capturedAt ? "embedded" : filenameDate ? "filename" : "drive-created";
            cache[captureDateCacheKey(photo)] = item.capturedAt || null;
          }
        } catch (error) {
          console.error("Could not read original media dates", error);
          failed += batch.ids.length;
          for (const id of batch.ids) {
            const photo = photoById.get(id);
            if (!photo) continue;
            const filenameDate = whatsappFilenameCaptureDate(photo.name);
            photo.capturedAt = filenameDate || photo.driveCreatedAt || null;
            photo.captureDateSource = filenameDate ? "filename" : "drive-created";
          }
        }
        scanned += batch.ids.length;
        if (showProgress) renderProgress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, scanQueue));
  }
  writeCaptureDateCache(cache);
  dateScanFailureCount = failed;
  filenameDateFallbackCount = items.filter(photo =>
    photo.needsEmbeddedDate && photo.captureDateSource === "filename"
  ).length;
  embeddedDateFallbackCount = items.filter(photo =>
    photo.needsEmbeddedDate && photo.captureDateSource === "drive-created"
  ).length;
}
async function loadGallery(silent = false) {
  if (galleryLoadInProgress) return;
  galleryLoadInProgress = true;
  if (!silent) app.innerHTML = `<main class="shell"><div class="loading">Loading your private gallery…</div></main>`;
  try {
    const [data, likesData] = await Promise.all([
      api("/api/photos"),
      api("/api/likes")
    ]);
    const nextPhotos = data.photos || [];
    await resolveEmbeddedDates(nextPhotos, data.dateBatches || [], !silent);
    const likesByFileId = new Map(likesData.likes.map(like => [like.fileId, like]));
    photos = sortPhotosByMediaDate(nextPhotos).map(photo => {
      const like = likesByFileId.get(photo.id);
      return {
        ...photo,
        likeCount: like?.likeCount || 0,
        likedByMe: Boolean(like?.likedByMe),
        isFavorite: Boolean(like?.isFavorite)
      };
    });
    lastGalleryLoadAt = Date.now();
    galleryRefreshError = "";
    renderTimeline();
  } catch (error) {
    if (error.status === 401) {
      galleryUser = null;
      return renderLogin();
    }
    console.error("Could not load the gallery", error);
    if (silent && photos.length) {
      galleryRefreshError = "Automatic refresh failed; showing the previous gallery.";
      const footer = document.querySelector(".gallery-footer");
      if (footer) footer.textContent = galleryRefreshError;
    } else {
      app.innerHTML = `<main class="shell"><div class="error">Could not load the gallery. Check your Cloudflare Worker logs and Google Drive configuration.</div><button class="btn" id="retry">Try again</button></main>`;
      document.querySelector("#retry").addEventListener("click", loadGallery);
    }
  } finally {
    galleryLoadInProgress = false;
  }
}
function openLightbox(index, items = photos) {
  currentIndex = index;
  visiblePhotos = items;
  renderLightbox();
}
function renderLightbox() {
  const p = visiblePhotos[currentIndex];
  if (!p) return;
  const video = p.mimeType.startsWith("video/");
  const media = video
    ? `<video src="${mediaUrl(p)}" controls autoplay playsinline></video>`
    : `<img src="${mediaUrl(p)}" alt="${escapeHtml(p.name)}" />`;
  const layer = document.createElement("div");
  layer.className = "lightbox";
  layer.innerHTML = `
    <div class="lightbox-top"><span>${escapeHtml(p.name)} · ${currentIndex+1} of ${visiblePhotos.length}</span><div class="lightbox-actions"><button class="btn lightbox-like" id="like-media" type="button" aria-label="${p.likedByMe ? "Unlike" : "Like"} media" aria-pressed="${p.likedByMe}"><span class="like-heart" aria-hidden="true">♥</span><span class="lightbox-like-count">${p.likeCount}</span></button><a class="btn" href="${mediaUrl(p)}?download=1" download="${escapeHtml(p.name)}">Download</a><button class="btn" id="close-lightbox">Close ✕</button><span class="like-status" id="like-status" aria-live="polite"></span></div></div>
    <div class="lightbox-main"><button class="nav-btn" id="prev" aria-label="Previous">‹</button>${media}<button class="nav-btn" id="next" aria-label="Next">›</button></div>
    <div class="lightbox-bottom">${escapeHtml(photoDateTimeLabel(p))} · ${escapeHtml(formatFileSize(p.sizeBytes))}</div>`;
  document.body.appendChild(layer);
  const close = () => { layer.remove(); document.removeEventListener("keydown", onKey); };
  const likeButton = layer.querySelector("#like-media");
  likeButton.addEventListener("click", async () => {
    if (likeButton.disabled) return;
    likeButton.disabled = true;
    const likeStatus = layer.querySelector("#like-status");
    try {
      const response = await api(`/api/likes/${encodeURIComponent(p.id)}`, {
        method: p.likedByMe ? "DELETE" : "PUT"
      });
      p.likeCount = response.likeCount;
      p.likedByMe = response.likedByMe;
      p.isFavorite = response.isFavorite;
      if (likeStatus) likeStatus.textContent = "";
      renderTimelineContent();
      if (galleryUser?.isAdmin && activeAlbum === "favorites" && !p.isFavorite) {
        close();
        return;
      }
      likeButton.setAttribute("aria-pressed", String(p.likedByMe));
      likeButton.setAttribute("aria-label", `${p.likedByMe ? "Unlike" : "Like"} media`);
      layer.querySelector(".lightbox-like-count").textContent = String(p.likeCount);
      likeButton.disabled = false;
    } catch (error) {
      console.error("Could not update media like", error);
      if (likeStatus) likeStatus.textContent = error instanceof Error ? error.message : "Could not update like.";
      likeButton.disabled = false;
    }
  });
  const onKey = event => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft") { currentIndex = (currentIndex - 1 + visiblePhotos.length) % visiblePhotos.length; layer.remove(); renderLightbox(); }
    if (event.key === "ArrowRight") { currentIndex = (currentIndex + 1) % visiblePhotos.length; layer.remove(); renderLightbox(); }
  };
  layer.querySelector("#close-lightbox").addEventListener("click", close);
  layer.querySelector("#prev").addEventListener("click", () => { currentIndex = (currentIndex - 1 + visiblePhotos.length) % visiblePhotos.length; layer.remove(); renderLightbox(); });
  layer.querySelector("#next").addEventListener("click", () => { currentIndex = (currentIndex + 1) % visiblePhotos.length; layer.remove(); renderLightbox(); });
  layer.addEventListener("click", event => { if (event.target === layer) close(); });
  document.addEventListener("keydown", onKey);
}
(async function init() {
  let startupError = "";
  try {
    const me = await api("/api/me");
    if (me.authenticated) {
      galleryUser = me;
      await loadGallery();
      return;
    }
  } catch (error) {
    console.error("Could not check the current sign-in status", error);
    startupError = "Could not check sign-in status. Please try signing in again.";
  }
  const error = new URL(location.href).searchParams.get("error");
  const messages = {
    "auth-not-configured": "Google sign-in is not configured yet.",
    "not-authorized": "This Gmail account has not been approved by an administrator.",
    "sign-in-cancelled": "Google sign-in was cancelled.",
    "sign-in-failed": "Google sign-in could not be completed. Please try again."
  };
  if (error) history.replaceState(null, "", location.pathname);
  renderLogin(messages[error] || startupError);
})();

setInterval(() => {
  if (document.visibilityState === "visible" && Date.now() - lastGalleryLoadAt >= AUTO_REFRESH_INTERVAL_MS) {
    loadGallery(true);
  }
}, AUTO_REFRESH_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    lastGalleryLoadAt &&
    Date.now() - lastGalleryLoadAt >= AUTO_REFRESH_INTERVAL_MS
  ) loadGallery(true);
});
