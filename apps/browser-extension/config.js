// config.js — origin resolution for the "TextStack — Save to read later" extension.
//
// PROD has TWO bases that differ by path:
//   • Site origin (SPA):  https://textstack.app          — /connect-extension, /en/library, reader links
//   • API base:           https://textstack.app/api      — /auth/*, /me/* (nginx proxies /api → backend)
// So the extension must NOT collapse them into one origin (the API lives under /api).
//
// Overrides (options page, for local dev):
//   • siteOrigin  e.g. http://localhost:5173  (web dev server)
//   • apiBase     e.g. http://localhost:8080  (backend at root — no /api in dev)
// If apiBase is unset it defaults to `${siteOrigin}/api` (the prod shape).

export const DEFAULT_SITE_ORIGIN = "https://textstack.app";
export const CONNECT_PATH = "/connect-extension";

const stripTrailingSlash = (s) => String(s).trim().replace(/\/+$/, "");

/** Web/SPA origin (connect page, library + reader links). No trailing slash. */
export async function getSiteOrigin() {
  const { siteOrigin } = await chrome.storage.local.get("siteOrigin");
  return stripTrailingSlash((siteOrigin && String(siteOrigin).trim()) || DEFAULT_SITE_ORIGIN);
}

/** API base for /auth/* and /me/* calls. Defaults to `${siteOrigin}/api` (prod). */
export async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  if (apiBase && String(apiBase).trim()) return stripTrailingSlash(apiBase);
  return (await getSiteOrigin()) + "/api";
}
