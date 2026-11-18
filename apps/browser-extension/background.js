// background.js — MV3 service worker (type: module). The orchestration hub:
//   • registers context menus
//   • drives the device-flow poll on chrome.alarms ticks
//   • routes messages from the popup (extract, clip, connect, status)
//   • performs the on-demand content-script injection + extraction
//
// All network/auth lives here and in lib/*. The SW can be evicted between events,
// so it holds no long-lived in-memory state (flow state is in chrome.storage.local).

import { POLL_ALARM, pollOnce, startDeviceFlow, isConnected, disconnect, getTokens } from "./lib/auth.js";
import { clip, listReadLater, deleteClip, me, NotConnectedError } from "./lib/api.js";

const MENU_PAGE = "textstack-clip-page";
const MENU_SELECTION = "textstack-clip-selection";

// ── lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: "Clip page to TextStack",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: MENU_SELECTION,
    title: "Clip selection to TextStack",
    contexts: ["selection"],
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollOnce().catch((e) => console.warn("[TextStack] poll error", e));
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  const mode = info.menuItemId === MENU_SELECTION ? "selection" : "page";
  clipActiveTab(tab, mode).catch((e) => notify(`Clip failed: ${e.message}`));
});

// ── message router (popup ↔ background) ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message, notConnected: !!e.notConnected }));
  return true; // async response
});

async function handleMessage(msg) {
  switch (msg?.type) {
    case "status":
      return getStatus();
    case "connect":
      return startDeviceFlow();
    case "disconnect":
      await disconnect();
      return { connected: false };
    case "hasSelection": {
      const tab = await activeTab();
      return { hasSelection: await hasSelection(tab) };
    }
    case "extract": {
      const tab = await activeTab();
      return extractFromTab(tab, msg.mode || "page");
    }
    case "clip":
      return clip(msg.payload);
    case "clipActive": {
      const tab = await activeTab();
      return clipActiveTab(tab, msg.mode || "page");
    }
    case "recent":
      return listReadLater();
    case "delete": {
      await deleteClip(msg.id);
      return { deleted: true };
    }
    case "me":
      return me();
    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}

// ── status ───────────────────────────────────────────────────────────────────

async function getStatus() {
  const connected = await isConnected();
  let email = null;
  if (connected) {
    try {
      const profile = await me();
      email = profile?.user?.email || null;
    } catch (e) {
      if (e instanceof NotConnectedError) return { connected: false };
      // Transient — still report connected.
    }
  }
  return { connected, email };
}

// ── selection probe (for greying "Send selection" like Kindle) ───────────────

async function hasSelection(tab) {
  if (!tab || tab.id == null || !/^https?:/i.test(tab.url || "")) return false;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection()?.toString() || "").trim().length > 0,
    });
    return !!result;
  } catch {
    // Injection blocked (e.g. chrome:// or restricted page) → no selection.
    return false;
  }
}

// ── article extraction (inject readability + content, then call extractor) ────

async function extractFromTab(tab, mode) {
  if (!tab || tab.id == null) throw new Error("No active tab.");
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["lib/readability.js", "content.js"],
  });
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [mode],
    func: (m) => window.__textstackExtract(m),
  });
  if (!result || !result.ok) {
    throw new Error(result?.error || "Could not extract article content.");
  }
  return { ...result, sourceUrl: tab.url };
}

// ── high-level actions ───────────────────────────────────────────────────────

/** Extract + clip in one shot (used by context menus and the popup's quick button). */
async function clipActiveTab(tab, mode) {
  const article = await extractFromTab(tab, mode);
  const result = await clip({
    title: article.title,
    author: article.byline,
    sourceUrl: article.sourceUrl,
    html: article.content,
    language: article.lang,
  });
  notify("Clipped to TextStack");
  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function notify(message) {
  // Best-effort badge feedback (no "notifications" permission requested).
  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
  console.info("[TextStack]", message);
}

// Surface tokens for debugging in the SW console (not exported to pages).
globalThis.__textstackTokens = getTokens;
