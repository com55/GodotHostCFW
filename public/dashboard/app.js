// ========================================
// Dashboard App - Godot Host (Cloudflare)
// ========================================

import { unzip } from "./vendor/fflate.module.js";

const API = {
  auth: {
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    me: "/api/auth/me",
  },
  games: "/api/games",
};

// ========================================
// State
// ========================================

/** @type {any[]} */
let games = [];

// ========================================
// DOM References
// ========================================

const $ = (/** @type {string} */ sel) => document.querySelector(sel);
const $$ = (/** @type {string} */ sel) => document.querySelectorAll(sel);

const loginScreen = /** @type {HTMLElement} */ ($("#login-screen"));
const dashboardScreen = /** @type {HTMLElement} */ ($("#dashboard-screen"));
const loginForm = /** @type {HTMLFormElement} */ ($("#login-form"));
const loginError = /** @type {HTMLElement} */ ($("#login-error"));
const logoutBtn = /** @type {HTMLButtonElement} */ ($("#logout-btn"));
const adminName = /** @type {HTMLElement} */ ($("#admin-name"));

const gamesList = /** @type {HTMLElement} */ ($("#games-list"));
const emptyState = /** @type {HTMLElement} */ ($("#empty-state"));

const statTotal = /** @type {HTMLElement} */ ($("#stat-total"));
const statPublic = /** @type {HTMLElement} */ ($("#stat-public"));
const statPrivate = /** @type {HTMLElement} */ ($("#stat-private"));

// ========================================
// Utility
// ========================================

/** @param {number} bytes */
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + sizes[i];
}

/** @param {string} dateStr */
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** @type {AbortController | null} */
let currentUploadController = null;

// ----- Upload pipeline: extract ZIP in-browser, upload files to R2 -----
// Large files use R2 multipart uploads with parallel parts (chunked + parallel,
// like the original). Everything heavy happens on the client; the Worker just
// streams parts into R2.

const PART_SIZE = 25 * 1024 * 1024; // 25MB per multipart part
const UPLOAD_CONCURRENCY = 4; // parallel parts in flight

const signal = () => currentUploadController?.signal;

/**
 * Extract a Godot web-export ZIP in the browser.
 * @param {File} file
 * @returns {Promise<[string, Uint8Array][]>} list of [path, bytes]
 */
async function extractZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  /** @type {Record<string, Uint8Array>} */
  const entries = await new Promise((resolve, reject) =>
    unzip(buf, (err, data) => (err ? reject(err) : resolve(data)))
  );
  let files = /** @type {[string, Uint8Array][]} */ (
    Object.entries(entries).filter(([name]) => !name.endsWith("/"))
  );
  files = flattenRoot(files);
  if (!files.some(([name]) => name === "index.html")) {
    throw new Error("No index.html found in the ZIP. Are you sure this is a Godot web export?");
  }
  return files;
}

/**
 * If everything sits inside a single wrapping folder, strip it.
 * @param {[string, Uint8Array][]} files
 */
function flattenRoot(files) {
  if (files.some(([n]) => n === "index.html")) return files;
  const roots = new Set(files.map(([n]) => n.split("/")[0]));
  if (roots.size === 1) {
    const prefix = [...roots][0] + "/";
    const stripped = /** @type {[string, Uint8Array][]} */ (
      files.map(([n, d]) => [n.slice(prefix.length), d])
    );
    if (stripped.some(([n]) => n === "index.html")) return stripped;
  }
  return files;
}

/**
 * Pick the file to use as the game's favicon.
 * @param {[string, Uint8Array][]} files
 */
function detectIcon(files) {
  const names = files.map(([n]) => n);
  return (
    names.find((n) => n.toLowerCase() === "icon.png") ||
    names.find((n) => n.toLowerCase().includes("icon") && n.endsWith(".png")) ||
    names.find((n) => n.endsWith(".png")) ||
    ""
  );
}

/** @param {Response} res @param {string} fallback */
async function errMsg(res, fallback) {
  try {
    const j = await res.json();
    return j.error || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Upload all extracted files under `prefix` (e.g. "games/my-game/v1").
 * @param {[string, Uint8Array][]} files
 * @param {string} prefix
 * @param {(loaded: number, total: number) => void} onProgress
 */
async function deployFiles(files, prefix, onProgress) {
  const total = files.reduce((sum, [, d]) => sum + d.length, 0);
  let uploaded = 0;
  const tick = (/** @type {number} */ n) => {
    uploaded += n;
    onProgress(uploaded, total);
  };

  for (const [path, data] of files) {
    const key = `${prefix}/${path}`;
    if (data.length <= PART_SIZE) {
      await putSmall(key, data);
      tick(data.length);
    } else {
      await putMultipart(key, data, tick);
    }
  }
  return total;
}

/** @param {string} key @param {Uint8Array} data */
async function putSmall(key, data) {
  const res = await fetch(`/api/upload/put?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    body: data,
    signal: signal(),
  });
  if (!res.ok) throw new Error(await errMsg(res, "Upload failed"));
}

/**
 * @param {string} key
 * @param {Uint8Array} data
 * @param {(n: number) => void} tick
 */
async function putMultipart(key, data, tick) {
  const createRes = await fetch(`/api/upload/mpu-create?key=${encodeURIComponent(key)}`, {
    method: "POST",
    signal: signal(),
  });
  if (!createRes.ok) throw new Error(await errMsg(createRes, "Failed to start upload"));
  const { uploadId } = await createRes.json();

  const numParts = Math.ceil(data.length / PART_SIZE);
  /** @type {{partNumber: number, etag: string}[]} */
  const parts = new Array(numParts);
  let nextPart = 0;

  async function worker() {
    while (true) {
      const i = nextPart++;
      if (i >= numParts) return;
      const start = i * PART_SIZE;
      const chunk = data.subarray(start, Math.min(start + PART_SIZE, data.length));
      const partNumber = i + 1;
      const res = await fetch(
        `/api/upload/mpu-part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`,
        { method: "PUT", body: chunk, signal: signal() }
      );
      if (!res.ok) throw new Error(await errMsg(res, "Chunk upload failed"));
      const json = await res.json();
      parts[i] = { partNumber, etag: json.etag };
      tick(chunk.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, numParts) }, worker));

  const completeRes = await fetch("/api/upload/mpu-complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, uploadId, parts }),
    signal: signal(),
  });
  if (!completeRes.ok) throw new Error(await errMsg(completeRes, "Failed to finalize upload"));
}

/**
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showToast(message, type = "info") {
  const container = /** @type {HTMLElement} */ ($("#toast-container"));
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", () => toast.remove());
  }, 3500);
}

/**
 * @param {HTMLElement} el
 * @param {boolean} show
 */
function toggle(el, show) {
  el.classList.toggle("hidden", !show);
}

// ========================================
// Auth
// ========================================

async function checkAuth() {
  try {
    const res = await fetch(API.auth.me);
    if (res.ok) {
      const data = await res.json();
      showDashboard(data.user?.username || "admin");
      return;
    }
  } catch {
    /* not authenticated */
  }
  showLogin();
}

/** @param {string} username */
function showDashboard(username) {
  loginScreen.classList.remove("active");
  dashboardScreen.classList.add("active");
  adminName.textContent = username;
  loadGames();
}

function showLogin() {
  dashboardScreen.classList.remove("active");
  loginScreen.classList.add("active");
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  toggle(loginError, false);

  const btn = /** @type {HTMLButtonElement} */ ($("#login-btn"));
  const btnText = /** @type {HTMLElement} */ (btn.querySelector(".btn-text"));
  const btnLoader = /** @type {HTMLElement} */ (
    btn.querySelector(".btn-loader")
  );

  btn.disabled = true;
  toggle(btnText, false);
  toggle(btnLoader, true);

  try {
    const res = await fetch(API.auth.login, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: /** @type {HTMLInputElement} */ ($("#username")).value,
        password: /** @type {HTMLInputElement} */ ($("#password")).value,
      }),
    });

    const data = await res.json();

    if (res.ok) {
      showDashboard(data.username);
    } else {
      loginError.textContent = data.error || "Login failed";
      toggle(loginError, true);
    }
  } catch {
    loginError.textContent = "Connection failed";
    toggle(loginError, true);
  } finally {
    btn.disabled = false;
    toggle(btnText, true);
    toggle(btnLoader, false);
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetch(API.auth.logout, { method: "POST" });
  showLogin();
  showToast("Logged out", "info");
});

// ========================================
// Games
// ========================================

async function loadGames() {
  try {
    const res = await fetch(API.games);
    if (!res.ok) throw new Error("Failed to load");
    const data = await res.json();
    games = data.games;
    renderGames();
    updateStats();
  } catch {
    showToast("Failed to load games", "error");
  }
}

function updateStats() {
  statTotal.textContent = String(games.length);
  statPublic.textContent = String(
    games.filter((g) => g.visibility === "public").length,
  );
  statPrivate.textContent = String(
    games.filter((g) => g.visibility === "private").length,
  );
}

function renderGames() {
  if (games.length === 0) {
    toggle(gamesList, false);
    toggle(emptyState, true);
    return;
  }

  toggle(gamesList, true);
  toggle(emptyState, false);

  gamesList.innerHTML = games
    .map((game) => {
      const activeVersion = game.versions?.find(
        (/** @type {any} */ v) => v.version === game.activeVersion,
      );
      const totalSize =
        game.versions?.reduce(
          (/** @type {number} */ sum, /** @type {any} */ v) =>
            sum + (v.fileSize || 0),
          0,
        ) || 0;

      return /*html*/ `
      <div class="game-card" data-slug="${game.slug}">
        <div class="game-card-header">
          <h4 class="game-title">${escapeHtml(game.title)}</h4>
          <span class="game-badge ${game.visibility}">${game.visibility}</span>
        </div>
        ${game.description ? `<p class="game-desc">${escapeHtml(game.description)}</p>` : ""}
        <div class="game-meta">
          <span>📦 ${formatSize(totalSize)}</span>
          <span>🏷️ v${game.activeVersion || 1} (${game.versions?.length || 1} versions)</span>
          <span>📅 ${formatDate(game.updatedAt)}</span>
        </div>
        <div class="game-actions">
          <button class="btn btn-primary btn-sm" onclick="openPlay('${game.slug}')">▶ Play</button>
          <button class="btn btn-ghost btn-sm" onclick="copyLink('${game.slug}')">🔗 Copy Link</button>
          <button class="btn btn-ghost btn-sm" onclick="openEdit('${game.slug}')">⚙️ Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="openVersionUpload('${game.slug}')">📤 New Ver</button>
          <button class="btn btn-ghost btn-sm" onclick="openDelete('${game.slug}', '${escapeHtml(game.title).replace(/'/g, "\\'")}')">🗑️ Delete</button>
        </div>
      </div>
    `;
    })
    .join("");
}

/** @param {string} str */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ========================================
// Play / Copy Link
// ========================================

/** @param {string} slug */
function openPlay(slug) {
  window.open(`/play/${slug}`, "_blank");
}

/** @param {string} slug */
async function copyLink(slug) {
  const url = `${window.location.origin}/play/${slug}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied!", "success");
  } catch {
    // Fallback
    const input = document.createElement("input");
    input.value = url;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    showToast("Link copied!", "success");
  }
}

// Make functions globally accessible
Object.assign(window, {
  openPlay,
  copyLink,
  openEdit,
  openDelete,
  openVersionUpload,
});

// ========================================
// Upload Modal
// ========================================

const uploadModal = /** @type {HTMLElement} */ ($("#upload-modal"));
const uploadForm = /** @type {HTMLFormElement} */ ($("#upload-form"));
const dropZone = /** @type {HTMLElement} */ ($("#drop-zone"));
const gameFile = /** @type {HTMLInputElement} */ ($("#game-file"));
const fileInfo = /** @type {HTMLElement} */ ($("#file-info"));
const fileName = /** @type {HTMLElement} */ ($("#file-name"));
const fileSize = /** @type {HTMLElement} */ ($("#file-size"));
const visibilitySelect = /** @type {HTMLSelectElement} */ (
  $("#game-visibility")
);
const accessCodeGroup = /** @type {HTMLElement} */ ($("#access-code-group"));

// Open upload modal
for (const btn of [
  /** @type {HTMLElement} */ ($("#upload-btn")),
  /** @type {HTMLElement} */ ($("#upload-btn-empty")),
]) {
  if (btn) {
    btn.addEventListener("click", () => {
      uploadForm.reset();
      /** @type {HTMLInputElement} */ ($("#game-file")).value = "";
      toggle(fileInfo, false);
      toggle(dropZone, true);
      toggle(
        /** @type {HTMLElement} */ ($("#upload-progress-container")),
        false,
      );
      toggle(/** @type {HTMLElement} */ ($("#upload-error")), false);
      toggle(accessCodeGroup, false);
      toggle(uploadModal, true);
    });
  }
}

// Visibility toggle
visibilitySelect.addEventListener("change", () => {
  toggle(accessCodeGroup, visibilitySelect.value === "private");
});

// Drop zone
["dragenter", "dragover"].forEach((event) => {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((event) => {
  dropZone.addEventListener(event, () => {
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    handleFileSelect(files[0]);
  }
});

gameFile.addEventListener("change", () => {
  if (gameFile.files && gameFile.files.length > 0) {
    handleFileSelect(gameFile.files[0]);
  }
});

/** @type {File|null} */
let selectedFile = null;

/** @param {File} file */
function handleFileSelect(file) {
  if (!file.name.endsWith(".zip")) {
    showToast("Please select a ZIP file", "error");
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  toggle(dropZone, false);
  toggle(fileInfo, true);
}

/** @type {HTMLButtonElement} */ ($("#file-remove")).addEventListener(
  "click",
  () => {
    if (currentUploadController) return;
    selectedFile = null;
    gameFile.value = "";
    toggle(fileInfo, false);
    toggle(dropZone, true);
  },
);

// Submit upload
uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedFile) {
    showToast("Please select a file", "error");
    return;
  }

  const title = /** @type {HTMLInputElement} */ ($("#game-title")).value.trim();
  if (!title) return;

  const submitBtn = /** @type {HTMLButtonElement} */ ($("#upload-submit-btn"));
  const progressContainer = /** @type {HTMLElement} */ ($("#upload-progress-container"));
  const progressBar = /** @type {HTMLElement} */ ($("#upload-progress-bar"));
  const progressText = /** @type {HTMLElement} */ ($("#upload-progress-text"));
  const uploadError = /** @type {HTMLElement} */ ($("#upload-error"));

  submitBtn.disabled = true;
  toggle(submitBtn.querySelector(".btn-text"), false);
  toggle(submitBtn.querySelector(".btn-loader"), true);
  toggle(progressContainer, true);
  toggle(uploadError, false);

  /** @type {string | null} */
  let createdSlug = null;
  try {
    currentUploadController = new AbortController();

    progressText.textContent = "Extracting...";
    const files = await extractZip(selectedFile);
    const iconPath = detectIcon(files);

    // Create the game record to reserve a slug + version.
    const createRes = await fetch(API.games, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: /** @type {HTMLTextAreaElement} */ ($("#game-desc")).value,
        visibility: visibilitySelect.value,
        accessCode: /** @type {HTMLInputElement} */ ($("#game-access-code")).value,
      }),
    });
    if (!createRes.ok) throw new Error(await errMsg(createRes, "Failed to create game"));
    const { slug, version } = await createRes.json();
    createdSlug = slug;

    const total = await deployFiles(files, `games/${slug}/v${version}`, (loaded, t) => {
      const pct = Math.round((loaded / t) * 100);
      progressBar.style.width = pct + "%";
      progressText.textContent = pct + "%";
    });

    progressBar.style.width = "100%";
    progressText.textContent = "Finalizing...";

    const finishRes = await fetch(`${API.games}/${slug}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, fileSize: total, iconPath }),
    });
    if (!finishRes.ok) throw new Error(await errMsg(finishRes, "Finalize failed"));

    currentUploadController = null;
    toggle(uploadModal, false);
    selectedFile = null;
    showToast("Game deployed successfully! 🎉", "success");
    loadGames();
  } catch (err) {
    // Roll back the half-created game so it doesn't linger.
    if (createdSlug) {
      fetch(`${API.games}/${createdSlug}`, { method: "DELETE" }).catch(() => {});
    }
    uploadError.textContent = err.message || "Upload failed";
    toggle(uploadError, true);
  } finally {
    currentUploadController = null;
    submitBtn.disabled = false;
    toggle(submitBtn.querySelector(".btn-text"), true);
    toggle(submitBtn.querySelector(".btn-loader"), false);
  }
});

// ========================================
// Edit Modal
// ========================================

const editModal = /** @type {HTMLElement} */ ($("#edit-modal"));
const editForm = /** @type {HTMLFormElement} */ ($("#edit-form"));
const editVisibility = /** @type {HTMLSelectElement} */ ($("#edit-visibility"));
const editAccessCodeGroup = /** @type {HTMLElement} */ (
  $("#edit-access-code-group")
);

editVisibility.addEventListener("change", () => {
  toggle(editAccessCodeGroup, editVisibility.value === "private");
});

/** @param {string} slug */
function openEdit(slug) {
  const game = games.find((g) => g.slug === slug);
  if (!game) return;

  /** @type {HTMLInputElement} */ ($("#edit-slug")).value = game.slug;
  /** @type {HTMLInputElement} */ ($("#edit-title")).value = game.title;
  /** @type {HTMLTextAreaElement} */ ($("#edit-desc")).value =
    game.description || "";
  editVisibility.value = game.visibility;
  /** @type {HTMLInputElement} */ ($("#edit-access-code")).value =
    game.accessCode || "";
  toggle(editAccessCodeGroup, game.visibility === "private");

  // Populate version selector
  const versionSelect = /** @type {HTMLSelectElement} */ (
    $("#edit-active-version")
  );
  versionSelect.innerHTML = (game.versions || [])
    .map(
      (/** @type {any} */ v) =>
        `<option value="${v.version}" ${v.version === game.activeVersion ? "selected" : ""}>
      v${v.version} - ${formatSize(v.fileSize)} (${formatDate(v.uploadedAt)})
    </option>`,
    )
    .join("");

  toggle(
    /** @type {HTMLElement} */ ($("#version-group")),
    (game.versions?.length || 0) > 1,
  );
  toggle(/** @type {HTMLElement} */ ($("#edit-error")), false);
  toggle(editModal, true);
}

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const slug = /** @type {HTMLInputElement} */ ($("#edit-slug")).value;
  const editError = /** @type {HTMLElement} */ ($("#edit-error"));

  const body = {
    title: /** @type {HTMLInputElement} */ ($("#edit-title")).value.trim(),
    description: /** @type {HTMLTextAreaElement} */ ($("#edit-desc")).value,
    visibility: editVisibility.value,
    accessCode: /** @type {HTMLInputElement} */ ($("#edit-access-code")).value,
    activeVersion: parseInt(
      /** @type {HTMLSelectElement} */ ($("#edit-active-version")).value,
      10,
    ),
  };

  try {
    const res = await fetch(`${API.games}/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      toggle(editModal, false);
      showToast("Game updated!", "success");
      loadGames();
    } else {
      const data = await res.json();
      editError.textContent = data.error || "Update failed";
      toggle(editError, true);
    }
  } catch {
    editError.textContent = "Connection failed";
    toggle(editError, true);
  }
});

// ========================================
// Version Upload Modal
// ========================================

const versionModal = /** @type {HTMLElement} */ ($("#version-modal"));
const versionForm = /** @type {HTMLFormElement} */ ($("#version-form"));
const versionDropZone = /** @type {HTMLElement} */ ($("#version-drop-zone"));
const versionFileInput = /** @type {HTMLInputElement} */ ($("#version-file"));
const versionFileInfo = /** @type {HTMLElement} */ ($("#version-file-info"));

/** @type {File|null} */
let versionSelectedFile = null;

/** @param {string} slug */
function openVersionUpload(slug) {
  /** @type {HTMLInputElement} */ ($("#version-slug")).value = slug;
  versionForm.reset();
  versionSelectedFile = null;
  toggle(versionFileInfo, false);
  toggle(versionDropZone, true);
  toggle(/** @type {HTMLElement} */ ($("#version-progress-container")), false);
  toggle(/** @type {HTMLElement} */ ($("#version-error")), false);
  toggle(versionModal, true);
}

["dragenter", "dragover"].forEach((event) => {
  versionDropZone.addEventListener(event, (e) => {
    e.preventDefault();
    versionDropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((event) => {
  versionDropZone.addEventListener(event, () => {
    versionDropZone.classList.remove("dragover");
  });
});

versionDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) handleVersionFileSelect(files[0]);
});

versionFileInput.addEventListener("change", () => {
  if (versionFileInput.files?.length)
    handleVersionFileSelect(versionFileInput.files[0]);
});

/** @param {File} file */
function handleVersionFileSelect(file) {
  if (!file.name.endsWith(".zip")) {
    showToast("Please select a ZIP file", "error");
    return;
  }
  versionSelectedFile = file;
  /** @type {HTMLElement} */ ($("#version-file-name")).textContent = file.name;
  /** @type {HTMLElement} */ ($("#version-file-size")).textContent = formatSize(
    file.size,
  );
  toggle(versionDropZone, false);
  toggle(versionFileInfo, true);
}

/** @type {HTMLButtonElement} */ ($("#version-file-remove")).addEventListener(
  "click",
  () => {
    if (currentUploadController) return;
    versionSelectedFile = null;
    versionFileInput.value = "";
    toggle(versionFileInfo, false);
    toggle(versionDropZone, true);
  },
);

versionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!versionSelectedFile) {
    showToast("Please select a file", "error");
    return;
  }

  const slug = /** @type {HTMLInputElement} */ ($("#version-slug")).value;

  const submitBtn = /** @type {HTMLButtonElement} */ ($("#version-submit-btn"));
  const progressContainer = /** @type {HTMLElement} */ (
    $("#version-progress-container")
  );
  const progressBar = /** @type {HTMLElement} */ ($("#version-progress-bar"));
  const progressText = /** @type {HTMLElement} */ ($("#version-progress-text"));
  const versionError = /** @type {HTMLElement} */ ($("#version-error"));

  submitBtn.disabled = true;
  toggle(submitBtn.querySelector(".btn-text"), false);
  toggle(submitBtn.querySelector(".btn-loader"), true);
  toggle(progressContainer, true);
  toggle(versionError, false);

  try {
    currentUploadController = new AbortController();

    progressText.textContent = "Extracting...";
    const files = await extractZip(versionSelectedFile);
    const iconPath = detectIcon(files);

    // Reserve the next version number for this game.
    const verRes = await fetch(`${API.games}/${slug}/versions`, { method: "POST" });
    if (!verRes.ok) throw new Error(await errMsg(verRes, "Failed to create version"));
    const { version } = await verRes.json();

    const total = await deployFiles(files, `games/${slug}/v${version}`, (loaded, t) => {
      const pct = Math.round((loaded / t) * 100);
      progressBar.style.width = pct + "%";
      progressText.textContent = pct + "%";
    });

    progressBar.style.width = "100%";
    progressText.textContent = "Finalizing...";

    const finishRes = await fetch(`${API.games}/${slug}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, fileSize: total, iconPath }),
    });
    if (!finishRes.ok) throw new Error(await errMsg(finishRes, "Finalize failed"));

    currentUploadController = null;
    toggle(versionModal, false);
    versionSelectedFile = null;
    showToast("New version uploaded! 🎉", "success");
    loadGames();
  } catch (err) {
    versionError.textContent = err.message || "Upload failed";
    toggle(versionError, true);
  } finally {
    currentUploadController = null;
    submitBtn.disabled = false;
    toggle(submitBtn.querySelector(".btn-text"), true);
    toggle(submitBtn.querySelector(".btn-loader"), false);
  }
});

// ========================================
// Delete Modal
// ========================================

const deleteModal = /** @type {HTMLElement} */ ($("#delete-modal"));

/**
 * @param {string} slug
 * @param {string} name
 */
function openDelete(slug, name) {
  /** @type {HTMLInputElement} */ ($("#delete-slug")).value = slug;
  /** @type {HTMLElement} */ ($("#delete-game-name")).textContent = name;
  toggle(deleteModal, true);
}

/** @type {HTMLButtonElement} */ ($("#delete-confirm-btn")).addEventListener(
  "click",
  async () => {
    const slug = /** @type {HTMLInputElement} */ ($("#delete-slug")).value;

    try {
      const res = await fetch(`${API.games}/${slug}`, { method: "DELETE" });
      if (res.ok) {
        toggle(deleteModal, false);
        showToast("Game deleted", "info");
        loadGames();
      } else {
        showToast("Failed to delete game", "error");
      }
    } catch {
      showToast("Connection failed", "error");
    }
  },
);

// ========================================
// Modal close handlers
// ========================================

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = /** @type {HTMLElement} */ (btn).dataset.close;
    
    if (target === "upload-modal" || target === "version-modal") {
      if (currentUploadController) {
        const isHtmlNode = btn instanceof HTMLElement;
        if (isHtmlNode && !btn.dataset.confirming) {
          // Ask for confirmation
          btn.dataset.confirming = "true";
          btn.dataset.oldHtml = btn.innerHTML;
          btn.innerHTML = btn.classList.contains("modal-close") ? "❓" : "Sure to cancel?";
          btn.style.color = "#ef4444"; // red
          
          setTimeout(() => {
            if (btn.dataset.confirming) {
              btn.innerHTML = btn.dataset.oldHtml || "";
              btn.style.color = "";
              delete btn.dataset.confirming;
              delete btn.dataset.oldHtml;
            }
          }, 3000);
          return; // prevent closing
        } else if (isHtmlNode) {
          // Confirmed
          currentUploadController.abort();
          currentUploadController = null;
          btn.innerHTML = btn.dataset.oldHtml || "";
          btn.style.color = "";
          delete btn.dataset.confirming;
          delete btn.dataset.oldHtml;
        }
      }
    }
    
    if (target) toggle(/** @type {HTMLElement} */ ($(`#${target}`)), false);
  });
});

// Close modals on overlay click disabled per user request
// document.querySelectorAll('.modal-overlay').forEach(overlay => {
//   overlay.addEventListener('click', (e) => {
//     if (e.target === overlay) toggle(/** @type {HTMLElement} */ (overlay), false);
//   });
// });

// ========================================
// Init
// ========================================

checkAuth();
