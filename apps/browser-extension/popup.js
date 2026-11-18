// popup.js — UI controller. Talks ONLY to background.js via chrome.runtime
// messages (the SW owns all auth/network). No tokens ever touch the popup.

import { getSiteOrigin } from "./config.js";

const $ = (id) => document.getElementById(id);

const views = {
  disconnected: $("view-disconnected"),
  actions: $("view-actions"),
  preview: $("view-preview"),
  success: $("view-success"),
};

let lastResult = null; // { userBookId, jobId, status }
let pendingArticle = null; // extracted article awaiting preview-confirm

// ── messaging ────────────────────────────────────────────────────────────────

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error("No response from background."));
      if (!resp.ok) {
        const err = new Error(resp.error || "Failed");
        err.notConnected = resp.notConnected;
        return reject(err);
      }
      resolve(resp.data);
    });
  });
}

// ── view helpers ─────────────────────────────────────────────────────────────

function show(name) {
  for (const [key, el] of Object.entries(views)) el.classList.toggle("hidden", key !== name);
}
function spinner(on) {
  $("spinner").classList.toggle("hidden", !on);
}
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.classList.remove("hidden");
}
function clearToast() {
  $("toast").classList.add("hidden");
}

// ── init ─────────────────────────────────────────────────────────────────────

async function init() {
  spinner(true);
  clearToast();
  try {
    const status = await send("status");
    if (!status.connected) {
      show("disconnected");
      spinner(false);
      return;
    }
    $("email").textContent = status.email || "";

    // Greyed "Send selection" until we know there's a live selection (like Kindle).
    await refreshSelectionState();

    show("actions");
    loadRecent();
  } catch (e) {
    if (e.notConnected) {
      show("disconnected");
    } else {
      toast(e.message, "err");
      show("disconnected");
    }
  } finally {
    spinner(false);
  }
}

async function refreshSelectionState() {
  const btn = $("btn-selection");
  try {
    const sel = await send("hasSelection");
    btn.disabled = !sel?.hasSelection;
  } catch {
    btn.disabled = true;
  }
}

async function loadRecent() {
  try {
    const clips = await send("recent");
    const list = $("recent-list");
    list.innerHTML = "";
    const recent = (clips || []).slice(0, 5);
    if (recent.length === 0) {
      $("recent").classList.add("hidden");
      return;
    }
    for (const c of recent) {
      list.appendChild(renderClip(c));
    }
    $("recent").classList.remove("hidden");
  } catch {
    $("recent").classList.add("hidden");
  }
}

function renderClip(c) {
  const wrap = document.createElement("div");
  wrap.className = "clip";

  const main = document.createElement("div");
  main.className = "clip-main";
  main.title = "Open in reader";
  main.addEventListener("click", () => openReader(c.id));

  const title = document.createElement("span");
  title.className = "clip-title";
  title.textContent = c.title || "Untitled";

  const meta = document.createElement("span");
  meta.className = "clip-meta";
  meta.textContent = `${domainOf(c.sourceUrl)} · ${statusLabel(c.status)}`;

  main.append(title, meta);

  const del = document.createElement("button");
  del.className = "clip-del";
  del.textContent = "×"; // ×
  del.title = "Delete clip";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteClip(c.id, wrap);
  });

  wrap.append(main, del);
  return wrap;
}

async function deleteClip(id, row) {
  if (!id) return;
  row.style.opacity = "0.5";
  try {
    await send("delete", { id });
    loadRecent();
  } catch (e) {
    row.style.opacity = "";
    handleErr(e);
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

$("btn-connect").addEventListener("click", async () => {
  clearToast();
  spinner(true);
  try {
    const { user_code } = await send("connect");
    $("connect-hint").textContent =
      `A TextStack tab opened. Approve code ${user_code} there, then reopen this popup.`;
  } catch (e) {
    toast(e.message, "err");
  } finally {
    spinner(false);
  }
});

$("btn-clip").addEventListener("click", () => runClip("page"));
$("btn-selection").addEventListener("click", () => runClip("selection"));

async function runClip(mode) {
  clearToast();
  spinner(true);
  try {
    lastResult = await send("clipActive", { mode });
    onSuccess();
  } catch (e) {
    handleErr(e);
  } finally {
    spinner(false);
  }
}

$("btn-preview").addEventListener("click", async () => {
  clearToast();
  spinner(true);
  try {
    pendingArticle = await send("extract", { mode: "page" });
    $("pv-title").value = pendingArticle.title || "";
    $("pv-author").value = pendingArticle.byline || "";
    $("pv-content").innerHTML = sanitizePreview(pendingArticle.content);
    show("preview");
  } catch (e) {
    handleErr(e);
  } finally {
    spinner(false);
  }
});

$("btn-pv-cancel").addEventListener("click", () => show("actions"));

$("btn-pv-send").addEventListener("click", async () => {
  if (!pendingArticle) return;
  spinner(true);
  try {
    lastResult = await send("clip", {
      payload: {
        title: $("pv-title").value.trim() || pendingArticle.title,
        author: $("pv-author").value.trim(),
        sourceUrl: pendingArticle.sourceUrl,
        html: pendingArticle.content,
        language: pendingArticle.lang,
      },
    });
    onSuccess();
  } catch (e) {
    handleErr(e);
  } finally {
    spinner(false);
  }
});

$("btn-open-reader").addEventListener("click", () => openReader(lastResult?.userBookId));
$("btn-open-library").addEventListener("click", () => openLibrary());
$("btn-done").addEventListener("click", () => init());

$("link-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── success / errors ─────────────────────────────────────────────────────────

function onSuccess() {
  show("success");
  loadRecent();
}

function handleErr(e) {
  if (e.notConnected) {
    show("disconnected");
    toast("Connection expired — reconnect.", "err");
  } else {
    toast(e.message, "err");
  }
}

async function openReader(id) {
  if (!id) return openLibrary();
  const origin = await getSiteOrigin();
  chrome.tabs.create({ url: `${origin}/en/library/my/${id}` });
}
async function openLibrary() {
  const origin = await getSiteOrigin();
  chrome.tabs.create({ url: `${origin}/en/library` });
}

// ── small utils ──────────────────────────────────────────────────────────────

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "clip";
  }
}
function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ready" || s === "completed" || s === "done") return "Ready";
  if (s === "failed" || s === "error") return "Failed";
  return "Processing";
}
// Strip scripts/styles from the preview render (defense-in-depth; this HTML is
// already Readability-cleaned, but the popup must never execute page script).
function sanitizePreview(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  tmp.querySelectorAll("script,style,iframe,object,embed").forEach((n) => n.remove());
  return tmp.innerHTML;
}

init();
