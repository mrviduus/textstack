// lib/auth.js — OAuth 2.0 Device Authorization Grant (RFC 8628) client for the
// extension. Ported from the C# reference DeviceFlowTokenProvider (AI-050).
//
// Flow:
//   1. requestCode()  → POST /auth/device/code → { device_code, user_code,
//      verification_uri, verification_uri_complete, interval, expires_in }.
//   2. We open a tab at verification_uri_complete so the (already-signed-in)
//      user approves in the web app.
//   3. A chrome.alarms tick polls POST /auth/device/token honoring
//      interval / slow_down / authorization_pending / expired_token / access_denied.
//   4. On approval we persist { access_token, refresh_token } in
//      chrome.storage.local. Refresh uses POST /auth/refresh-mobile (body { refreshToken }).
//
// The service worker can be evicted between alarm ticks, so ALL flow state lives
// in chrome.storage.local (key: "deviceFlow"), not in module memory.

import { getApiBase, getSiteOrigin, CONNECT_PATH } from "../config.js";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const TOKENS_KEY = "tokens"; // { access_token, refresh_token }
const FLOW_KEY = "deviceFlow"; // in-flight device flow state
export const POLL_ALARM = "textstack-device-poll";

// Treat the access token as expired this far ahead of real exp so an in-flight
// request can't race the clock and 401 mid-call.
const EXPIRY_SKEW_MS = 30_000;

// ── token storage ────────────────────────────────────────────────────────────

/** Stored tokens or null. */
export async function getTokens() {
  const { [TOKENS_KEY]: t } = await chrome.storage.local.get(TOKENS_KEY);
  return t || null;
}

async function setTokens(tokens) {
  await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
}

/** True if a (non-expired or refreshable) connection exists. */
export async function isConnected() {
  const t = await getTokens();
  return !!(t && t.access_token);
}

/** Clear all auth + flow state (Disconnect). */
export async function disconnect() {
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.storage.local.remove([TOKENS_KEY, FLOW_KEY]);
}

// ── access-token retrieval (with refresh) ────────────────────────────────────

/**
 * Return a usable access token, refreshing via /auth/refresh-mobile when the
 * cached one is expired. Returns null if not connected or refresh failed (caller
 * should then start a device flow).
 */
export async function getToken() {
  const tokens = await getTokens();
  if (!tokens || !tokens.access_token) return null;

  if (!isJwtExpired(tokens.access_token)) return tokens.access_token;

  if (tokens.refresh_token) {
    const refreshed = await tryRefresh(tokens.refresh_token);
    if (refreshed) {
      await setTokens(refreshed);
      return refreshed.access_token;
    }
  }
  // Refresh impossible/failed → drop tokens so the UI prompts a reconnect.
  await chrome.storage.local.remove(TOKENS_KEY);
  return null;
}

/** POST /auth/refresh-mobile { refreshToken } → new tokens, or null on failure. */
async function tryRefresh(refreshToken) {
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/auth/refresh-mobile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const body = await res.json(); // { user, accessToken, refreshToken } (camelCase)
    if (!body || !body.accessToken) return null;
    return {
      access_token: body.accessToken,
      refresh_token: body.refreshToken || refreshToken,
    };
  } catch {
    return null;
  }
}

// ── device flow ──────────────────────────────────────────────────────────────

/**
 * Start the device flow: request a code, open the connect tab, schedule polling.
 * Returns { user_code, verification_uri } for the popup to display.
 * If a flow is already in flight, returns its existing code instead.
 */
export async function startDeviceFlow() {
  const existing = await getFlow();
  if (existing && !flowExpired(existing)) {
    return { user_code: existing.user_code, verification_uri: existing.verification_uri };
  }

  const apiBase = await getApiBase();
  const res = await fetch(`${apiBase}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error("Could not reach TextStack to start authorization.");
  }
  const code = await res.json();
  if (!code || !code.device_code || !code.user_code) {
    throw new Error("TextStack returned an invalid device code.");
  }

  const intervalSec = code.interval > 0 ? code.interval : 5;
  const expiresInSec = code.expires_in > 0 ? code.expires_in : 600;
  // The connect page is a WEB route (no /api), so build it from the site origin.
  // Prefer our branded /connect-extension page (reads ?code= and runs the same
  // device-approve flow as /device); fall back only if we lack the user_code.
  const siteOrigin = await getSiteOrigin();
  const connectUrl = code.user_code
    ? `${siteOrigin}${CONNECT_PATH}?code=${encodeURIComponent(code.user_code)}`
    : code.verification_uri_complete || `${siteOrigin}${CONNECT_PATH}`;

  const flow = {
    device_code: code.device_code,
    user_code: code.user_code,
    verification_uri: code.verification_uri || `${siteOrigin}${CONNECT_PATH}`,
    connect_url: connectUrl,
    interval_sec: intervalSec,
    deadline_ms: Date.now() + expiresInSec * 1000,
  };
  await setFlow(flow);

  // Open the web connect page so the signed-in user can approve.
  await chrome.tabs.create({ url: connectUrl });

  // Schedule the first poll. chrome.alarms minimum period is 0.5 min in practice,
  // but delayInMinutes accepts sub-minute values which Chrome honors for the
  // first fire; we re-arm after each tick from the stored interval.
  await scheduleNextPoll(intervalSec);

  return { user_code: flow.user_code, verification_uri: flow.connect_url };
}

/**
 * Arm the poll alarm `seconds` from now. NOTE: in a packed extension Chrome
 * enforces a ~30s minimum alarm delay, so short device-flow intervals (e.g. 5s)
 * are effectively floored to ~30s — approval is still detected, just a touch
 * slower. We pass the real interval anyway so unpacked/dev behaves as expected.
 */
async function scheduleNextPoll(seconds) {
  await chrome.alarms.create(POLL_ALARM, { delayInMinutes: Math.max(seconds, 1) / 60 });
}

/**
 * One poll tick (called from the alarms handler). Polls /auth/device/token and
 * either stores tokens (approved), re-arms the alarm (pending/slow_down), or
 * ends the flow (terminal/expired). Returns a status string for logging.
 */
export async function pollOnce() {
  const flow = await getFlow();
  if (!flow) return "no-flow";

  if (flowExpired(flow)) {
    await endFlow();
    return "expired";
  }

  let outcome;
  try {
    outcome = await pollToken(flow.device_code);
  } catch {
    // Transport blip — keep polling until the device code expires.
    await scheduleNextPoll(flow.interval_sec);
    return "transient";
  }

  switch (outcome.kind) {
    case "approved":
      await setTokens(outcome.tokens);
      await endFlow();
      return "approved";
    case "pending":
      await scheduleNextPoll(flow.interval_sec);
      return "pending";
    case "slow_down":
      flow.interval_sec += 5;
      await setFlow(flow);
      await scheduleNextPoll(flow.interval_sec);
      return "slow_down";
    case "terminal":
    default:
      await endFlow();
      return "terminal";
  }
}

/** POST /auth/device/token → outcome { kind, tokens? }. */
async function pollToken(deviceCode) {
  const apiBase = await getApiBase();
  const res = await fetch(`${apiBase}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ grant_type: GRANT_TYPE, device_code: deviceCode }),
  });

  if (res.ok) {
    const body = await res.json(); // { access_token, refresh_token, ... }
    if (!body || !body.access_token) return { kind: "terminal" };
    return {
      kind: "approved",
      tokens: { access_token: body.access_token, refresh_token: body.refresh_token || "" },
    };
  }

  if (res.status === 400) {
    let err = "";
    try {
      err = (await res.json())?.error || "";
    } catch {
      /* ignore parse error */
    }
    if (err === "authorization_pending") return { kind: "pending" };
    if (err === "slow_down") return { kind: "slow_down" };
    // expired_token / access_denied / anything else → terminal.
    return { kind: "terminal" };
  }

  // Other statuses: treat as a transient blip — keep polling.
  return { kind: "pending" };
}

// ── flow state helpers ───────────────────────────────────────────────────────

async function getFlow() {
  const { [FLOW_KEY]: f } = await chrome.storage.local.get(FLOW_KEY);
  return f || null;
}
async function setFlow(flow) {
  await chrome.storage.local.set({ [FLOW_KEY]: flow });
}
async function endFlow() {
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.storage.local.remove(FLOW_KEY);
}
function flowExpired(flow) {
  return Date.now() >= (flow.deadline_ms || 0);
}

// ── local JWT exp decode (NO signature validation) ───────────────────────────

/** True if the JWT's exp is within EXPIRY_SKEW_MS of now (or unparseable). */
function isJwtExpired(jwt) {
  const exp = readExpMs(jwt);
  if (exp == null) return true;
  return Date.now() >= exp - EXPIRY_SKEW_MS;
}

function readExpMs(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

function base64UrlDecode(seg) {
  let s = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  return atob(s);
}
