// lib/api.js — authenticated fetch wrapper for the TextStack API.
//
// Always sends `Authorization: Bearer <jwt>` and `credentials: "omit"` (clean
// Bearer, no CORS-with-credentials). On 401 it refreshes the token once via
// lib/auth.getToken() and retries the request.

import { getApiBase } from "../config.js";
import { getToken } from "./auth.js";

class NotConnectedError extends Error {
  constructor() {
    super("Not connected to TextStack.");
    this.name = "NotConnectedError";
    this.notConnected = true;
  }
}

/** Core request: attaches Bearer, retries once on 401 after a token refresh. */
async function request(path, { method = "GET", body, isForm = false, retry = true } = {}) {
  const token = await getToken();
  if (!token) throw new NotConnectedError();

  const apiBase = await getApiBase();
  const headers = { Authorization: `Bearer ${token}` };
  let payload = body;
  if (body != null && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    credentials: "omit",
    body: payload,
  });

  // 401 → refresh + retry once. getToken() drops the stale access token after a
  // failed refresh, so the retry either uses a fresh token or throws NotConnected.
  if (res.status === 401 && retry) {
    const fresh = await getToken();
    if (fresh && fresh !== token) {
      return request(path, { method, body, isForm, retry: false });
    }
    throw new NotConnectedError();
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** POST /me/books/clip — { Title, Author?, SourceUrl?, Html, Language? } → { userBookId, jobId, status }. */
export function clip({ title, author, sourceUrl, html, language }) {
  return request("/me/books/clip", {
    method: "POST",
    body: {
      Title: title,
      Author: author || null,
      SourceUrl: sourceUrl || null,
      Html: html,
      Language: language || "en",
    },
  });
}

/** GET /me/books?shelf=readlater → recent clips (UserBookListDto[]). */
export function listReadLater() {
  return request("/me/books?shelf=readlater");
}

/** DELETE /me/books/{id} → removes a clip / user book. */
export function deleteClip(id) {
  return request(`/me/books/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** GET /auth/me → { user: { id, email, name, ... } }. */
export function me() {
  return request("/auth/me");
}

export { NotConnectedError };
