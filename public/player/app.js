// ========================================
// Game Player App
// ========================================

// Slug comes from the URL: /play/<slug>
const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");

const $ = (/** @type {string} */ sel) => document.querySelector(sel);

const accessScreen = /** @type {HTMLElement} */ ($("#access-screen"));
const loadingScreen = /** @type {HTMLElement} */ ($("#loading-screen"));
const gameContainer = /** @type {HTMLElement} */ ($("#game-container"));
const errorScreen = /** @type {HTMLElement} */ ($("#error-screen"));
const gameIframe = /** @type {HTMLIFrameElement} */ ($("#game-iframe"));

/** Active version, learned from /info. Used to build the immutable game path. */
let activeVersion = 0;

/**
 * @param {'access'|'loading'|'game'|'error'} screen
 * @param {string} [errorMsg]
 */
function showScreen(screen, errorMsg) {
  accessScreen.classList.toggle("hidden", screen !== "access");
  loadingScreen.classList.toggle("hidden", screen !== "loading");
  gameContainer.classList.toggle("hidden", screen !== "game");
  errorScreen.classList.toggle("hidden", screen !== "error");

  if (screen === "error" && errorMsg) {
    /** @type {HTMLElement} */ ($("#error-message")).textContent = errorMsg;
  }
}

// ========================================
// Start
// ========================================

async function init() {
  if (!slug) {
    showScreen("error", "Invalid game URL");
    return;
  }

  showScreen("loading");

  let info;
  try {
    const res = await fetch(`/api/games/${slug}/info`);
    if (!res.ok) throw new Error("not found");
    info = await res.json();
  } catch {
    showScreen("error", "Game not found");
    return;
  }

  activeVersion = info.activeVersion;
  document.title = `${info.title} - Game Host`;
  /** @type {HTMLElement} */ ($("#game-title-bar")).textContent = info.title;
  /** @type {HTMLElement} */ ($("#access-game-title")).textContent = info.title;

  // Show version + description after the title
  const meta = /** @type {HTMLElement} */ ($("#game-meta"));
  if (info.description) {
    meta.classList.remove("hidden");
    /** @type {HTMLElement} */ ($("#game-version")).textContent = `v${info.activeVersion}`;
    const descEl = /** @type {HTMLElement} */ ($("#game-desc"));
    descEl.textContent = info.description;
    descEl.addEventListener("click", () => showDescModal(info.description));
  }
  if (info.iconPath) {
    /** @type {HTMLLinkElement} */ ($("#favicon")).href = `/g/${slug}/v${activeVersion}/${info.iconPath}`;
  }

  if (info.visibility === "private") {
    showScreen("access");
    setupAccessForm();
  } else {
    loadGame();
  }
}

// ========================================
// Access Code
// ========================================

function setupAccessForm() {
  const form = /** @type {HTMLFormElement} */ ($("#access-form"));
  const input = /** @type {HTMLInputElement} */ ($("#access-code-input"));
  const error = /** @type {HTMLElement} */ ($("#access-error"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.classList.add("hidden");

    const code = input.value.trim();
    if (!code) return;

    try {
      const res = await fetch(`/api/games/${slug}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: code }),
      });

      const data = await res.json();

      if (data.granted) {
        loadGame();
      } else {
        error.textContent = "Invalid access code";
        error.classList.remove("hidden");
        input.focus();
        input.select();
      }
    } catch {
      error.textContent = "Connection error. Please try again.";
      error.classList.remove("hidden");
    }
  });

  input.focus();
}

// ========================================
// Load Game
// ========================================

function loadGame() {
  showScreen("loading");

  // Versioned, immutable path served straight from R2 with the COOP/COEP
  // headers Godot needs. Relative requests from the game resolve under it.
  const gameSrc = `/g/${slug}/v${activeVersion}/index.html`;

  gameIframe.addEventListener("load", () => showScreen("game"), { once: true });
  gameIframe.addEventListener(
    "error",
    () => showScreen("error", "Failed to load game files"),
    { once: true }
  );

  const timeout = setTimeout(() => {
    if (!loadingScreen.classList.contains("hidden")) showScreen("game");
  }, 10000);
  gameIframe.addEventListener("load", () => clearTimeout(timeout), { once: true });

  gameIframe.src = gameSrc;
}

// ========================================
// Fullscreen
// ========================================

/** @type {HTMLButtonElement} */ ($("#fullscreen-btn")).addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    gameContainer.requestFullscreen().catch(() => {
      gameIframe.requestFullscreen().catch(() => {
        /* ignore */
      });
    });
  }
});

// ========================================
// Description Modal
// ========================================

function showDescModal(description) {
  // Remove existing modal if any
  const existing = document.getElementById("desc-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "desc-modal";
  overlay.className = "desc-overlay";

  const card = document.createElement("div");
  card.className = "desc-card";

  const heading = document.createElement("h3");
  heading.textContent = "Description";

  const para = document.createElement("p");
  para.className = "desc-text";
  para.textContent = description;

  const closeBtn = document.createElement("button");
  closeBtn.className = "desc-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => overlay.remove());

  card.append(heading, para, closeBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ========================================
// Init
// ========================================

init();
