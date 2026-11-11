# V2 reader page on the web: production hosting

**Date:** 2026-11-11 · **Status:** decided 2026-11-11: same origin for now (see the note below); §7 questions 1–2 answered, the rest open · **Wave:** 13 = wave A of
[`r8-parity-audit.md`](r8-parity-audit.md) §7 (line 218) · **Touches:** [ADR-029](adr/ADR-029-foliate-for-v2-epub.md)
Decision 4 (sandbox), [ADR-032](adr/ADR-032-one-engine-foliate-fork.md). Once decided, the decision becomes an ADR
(next free number: ADR-033).

Markers on browser claims: **[spec]** verified from the spec/docs text; **[exp]** needs an experiment. Code claims
cite `file:line` at `main` 9f86676f.

> **Owner decision, 2026-11-11:** the reader is built **inside the web app, on the app's own origin**
> (option C). No separate domain and no subdomain now: the route stays behind `Features:V2Api`, which is
> off in production, and the page CSP passed 30/30 hostile vectors. The recommendation below (option A)
> is kept as the analysis; a second origin is revisited before the flag goes on for real users (M5).
> First step: measure whether the page works under the production CSP at all (§3 C says it may not;
> that claim is untested), and scope any CSP change to the reader route only.

## 1. Problem

The web host is dev-only: `main.tsx:13` mounts `V2ReaderDevPage` only under `import.meta.env.DEV`, and
`apps/web/scripts/assert-no-dev-reader.mjs:6` fails the build if the page reaches `dist/`. When this doc was
written the page ran in `<iframe sandbox="allow-scripts allow-same-origin" srcDoc=…>` (`V2ReaderDevPage.tsx:221`);
since #1219 it is its own same-origin document, `<iframe … src="/reader-v2/frame.html">`, served by the dev server
(§2, the srcdoc finding). Either way `allow-same-origin` is
forced by foliate: it reads its section frames' documents directly (`paginator.js:244,251`, `fixed-layout.js:86,93`
in the local `.vendor/foliate-js` checkout). So the page runs on the app's origin, and the page CSP
(`carrier.mjs:11-12`) is the only barrier between a hostile book and the app origin. `sandbox.check.mjs` shows the
CSP holds 30/30 vectors (README "Sandbox", lines 233-282). It is one layer. This doc picks the second one.

## 2. Threat model: a book script running on the app origin

Assume one book script runs (a CSP bug, a browser bug, a future widening). What it reaches **on the app origin**,
today's dev host, if shipped as is:

| Asset | Exposure | Evidence |
|---|---|---|
| Auth cookies `access_token`, `refresh_token` | **Not readable** by JS: `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` (host-only), `Secure` outside Development, `MaxAge` = refresh TTL | `AuthEndpoints.cs:321-331`, `307-311` |
| The API **with** those cookies | **Full.** The script is same-origin with the app window: `parent.fetch('/api/me/…')` runs in the parent's realm, under the **app's** CSP (`connect-src 'self'`, `nginx textstack.conf:160`), not the page's `connect-src blob: data: file:` [spec reasoning, exp] | `client.ts:11-16` (cookie mode); `ClaimsPrincipalExtensions.cs:27-40` (cookie read when no Bearer) |
| — what that means | read the library, vocabulary, profile, highlights; download every book (`GET /me/v2/books/{id}/files/{fileId}/content`); **mint a long-lived MCP key** (`POST /me/mcp/keys`) and exfiltrate it through any channel the app CSP allows (`img-src https:` is open); delete the account (`DELETE /me/account`) | `McpKeysEndpoints.cs:27`, `AccountEndpoints.cs:17`, `V2Endpoints.cs:61` |
| `localStorage` / `sessionStorage` | Readable via `parent.localStorage`. **No tokens there** (web auth is cookie-only). Keys: native language, cookie consent, reader settings, dark mode, search history, library sort, reading progress caches, pending reading sessions, quick stats, pace, assistant launcher, Android tester banner | `NativeLanguageContext.tsx:14,66`, `useReaderSettings.ts:35`, `useReadingSession.ts:185`, `useUserBookProgress.ts:60`, … (grep `localStorage` in `apps/web/src`) |
| IndexedDB `textstack-reader` | Readable: offline catalog chapters | `offlineDb.ts:110` |
| The app DOM | Rewrite the UI (phishing a password form inside the real app) | — |
| Its own sandbox | With `allow-scripts allow-same-origin` on a same-origin frame, the frame can remove its own `sandbox` attribute [spec: HTML "sandbox" note] | — |

What the page's own CSP still blocks **inside the page's realm** (it does not bind the parent's functions):
`connect-src blob: data: file:` (no fetch/XHR/beacon to http), `img-src`/`font-src`/`media-src blob: data:` (no GET
beacons), `form-action 'none'` (plus no `allow-forms`), `frame-src blob:` (a section frame navigating itself to
`https:` is checked against its embedder's `frame-src`) [spec], `base-uri 'none'`. Not in the page CSP:
`frame-ancestors` and `sandbox` (both are **ignored in a `<meta>` CSP**) [spec: CSP3 §"meta element"]; `navigate-to`
(never shipped).

Top-level tricks: the outer iframe has no `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`, so
`top.location = …`, `window.open`, form posts and `alert` from the frame are blocked by the sandbox [spec] — but a
same-origin script can call `parent.open(…)` / `parent.location` itself, which runs as the app [exp]. Link clicks
leave only through `openLink` (`page.mjs:425`), which the host re-allowlists to `http(s)` and opens with
`noopener` (`V2ReaderDevPage.tsx:177-178`): an exfiltration channel the user sees, by design.

**Bottom line:** on the app origin the second layer is zero; one script = the user's account. Every option below is
judged by what remains if that one script runs.

A finding that matters for option C: the srcdoc document **inherits the app's CSP** (policy container cloned from the
parent) [spec; WPT `content-security-policy/inheritance/iframe-srcdoc-*`]. The app CSP (`textstack.conf:160`) has
`script-src 'self' …` (no nonce, no `'unsafe-inline'`), `frame-src https://accounts.google.com`, and no `blob:` in
`style-src`/`font-src`. Both policies enforce, so in production the page's nonce'd script, its `blob:` section frames
and the book's CSS and fonts would all be refused. **Measured** (Chromium, `prodCsp.check.mjs`, #1219): under the
exact app CSP the srcdoc page never sends `ready` (`script-src-elem`). Making srcdoc work takes five app-wide
additions, each shown necessary: a per-response script nonce, and `blob:` in `connect-src` (the page's `openUrl` read
of the book, missing from the list above), `frame-src`, `style-src` and `font-src`. The srcdoc dev host worked only
because the Vite dev server sends no CSP: **srcdoc cannot ship.** The page **as its own same-origin document**
(`<iframe src>`) can, measured: it carries only its own policy, and the app needs `frame-src 'self'` plus a location
that sends the frame's own headers (`frame-ancestors 'self'`; without them the server-level `frame-ancestors 'none'`
refuses it, #857). The dev host now does this (#1219).

## 3. Options

### A. Reader frame on a separate registrable domain (recommended)

**Mechanism.** A new domain (placeholder `READER_ORIGIN`, e.g. `https://<new-domain>`) serves exactly one static
file: the generated page with the host shim baked in. The app embeds `<iframe sandbox="allow-scripts
allow-same-origin" src="READER_ORIGIN/">`. `allow-same-origin` now only keeps the page's own origin, so foliate's
nested access works unchanged; the page is cross-origin **and cross-site** to the app.

**Protects.** A book script reaches: its own origin (no cookies set there, no API, empty storage), the book bytes it
was handed, and the protocol (`postMessage` to the host). Not the app DOM, storage, or API: cross-origin `parent` access
throws [spec]. Requests it could make to `textstack.app` are cross-site, so `SameSite=Lax` cookies are not attached to
subresource requests or POSTs [spec: RFC 6265bis]; its `connect-src` still blocks them anyway. It cannot toss cookies
onto `textstack.app` (different registrable domain) [spec].

**Costs.**
- Domain: buy one (~yearly fee), add a Cloudflare zone + DNS, add its hostname to the existing tunnel ingress
  (`operations.md:18-20`: Cloudflare DNS+SSL → tunnel → nginx :80). Cloudflare bot challenges must be off for that
  host: a challenge page inside an iframe cannot be solved [exp].
- nginx: one `server` block, one `location = /`, nothing else (no `/api`, no `/storage`). Headers:
  `Content-Security-Policy: frame-ancestors https://textstack.app; sandbox allow-scripts allow-same-origin`
  (header-only directives, §2), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`. The page's meta CSP stays byte-identical (ADR-029 D4 untouched; the header adds, never widens).
- **Nonce per response.** Today the host makes one per load (`V2ReaderDevPage.tsx:42,77-80`). A served static file
  cannot. Proposal: `sub_filter '__V2_READER_NONCE__' $request_id; sub_filter_once off;` — `$request_id` is 16 random
  bytes in hex [spec: nginx docs], which `v2ReaderPageHtml`'s nonce rule accepts (32 hex chars). Same trick fills
  `__V2_PARENT_ORIGIN__` in the shim. Needs `ngx_http_sub_module` on the server [exp: `nginx -V`]. Cost: the ~3.75 MB
  page is re-sent per open (no-store), compressed by nginx gzip after `sub_filter` [exp: measure].
- App side: app CSP `frame-src` gains `READER_ORIGIN` (`textstack.conf:160`). That is the only change to the app's
  headers.
- Build/deploy: a web build step writes `dist-reader/index.html` from `v2ReaderPage.generated.ts` (placeholder nonce
  kept) + the shim; the web image and `swap-web-dist.sh` carry it beside `dist/` (`operations.md:9`).

**What breaks / changes.**
- Bytes hand-off: unchanged in shape (ArrayBuffer transferred by `postMessage`, page makes a `blob:` URL its CSP
  admits, `V2ReaderDevPage.tsx:50-60,98-105`). Only the target changes: `postMessage(…, READER_ORIGIN, [buf])`
  instead of `location.origin` (`:99`), the host checks `e.origin === READER_ORIGIN` beside `e.source` (`:134`), the
  shim pins its parent origin instead of `location.origin` (`:64`). Transfer across origins works [spec].
- Storage: the page has none (host keeps all state), so third-party storage partitioning does not matter. `blob:`
  URLs are made and read in the same frame, so blob-URL partitioning does not either [exp: one e2e row proves it].
- Fonts: book fonts are `blob:` (unchanged). App fonts for wave B (e.g. a dyslexia font) must come from the reader
  origin or be transferred: decide in wave B.
- Drift checks: `check:v2-reader` unchanged (the committed artifact is the same); the served file is derived at
  build time, not committed.
- "Prod bundle unchanged": becomes **stronger**. The app `dist/` must never contain `__V2_READER_NONCE__` (the page
  can never run on the app origin); only `dist-reader/` may. The small host component ships in `dist/` behind the
  runtime V2 switch, so the `reader-v2|v2reader:` patterns in `assert-no-dev-reader.mjs:6` are replaced, not kept.
- Playwright: dev and e2e need two **sites**, not two ports (site ignores the port [spec]): app on
  `localhost:5173`, reader on `127.0.0.1:5174` (a tiny static server doing the same two substitutions as nginx).

**Tested by.** (1) The sandbox check gains a served-cross-origin run with the CSP bypassed (the existing positive
control, ADR-029 D6 R4 evidence: 21/30 escape) and asserts zero app reach: `parent.document` throws, no app
cookie/`localStorage` value seen, no request reaches the fake app's `/api` with its cookie. (2) `curl -sI
READER_ORIGIN/` in the deploy health check: no `Set-Cookie`, the header CSP present, nonce differs per request.
(3) `@v2` e2e opens an uploaded EPUB through the prod route.

### B. Reader frame on a subdomain (`reader.textstack.app`): same site, different origin

**Protects.** DOM, storage and `parent` access: same as A (cross-origin; `document.domain` relaxation is off by
default with origin-keyed agent clusters [spec/docs; exp on old WebViews]). Cookies are host-only, so not readable
there (`AuthEndpoints.cs:321-328`, no `Domain`).

**What same-site still allows** [spec: RFC 6265bis] — `SameSite=Lax` is about **site**, so requests from the
subdomain to `textstack.app/api` carry `access_token` for every method:
- *Reads:* blocked. CORS allows only listed origins (`ServiceCollectionExtensions.Cors.cs:11-27`); the response is
  opaque.
- *JSON writes:* blocked. `application/json` is not a CORS-simple type, so preflight fails; a `text/plain` body
  gets 415 from minimal-API JSON binding [docs; one integration test would pin it].
- *Simple-request writes: go through* (a `no-cors` POST, side effect happens, response unseen): `POST
  /auth/logout` and `/auth/refresh` (no body, `AuthEndpoints.cs:25,27`), `POST /me/v2/books/{id}/restore`
  (no body, `V2Endpoints.cs:51`), multipart `POST /me/books/upload` (`UserBooksEndpoints.cs:19-22`,
  `DisableAntiforgery`) and `POST /me/profile/avatar` (`ProfileEndpoints.cs:27`). The API checks no `Origin`,
  `Referer` or `Sec-Fetch-Site` (grep: none in `backend/src/Api`).
- *Cookie tossing:* a subdomain script can set `access_token` with `Domain=textstack.app; Path=/api/me` and log the
  user's requests into an **attacker's** account (vocabulary and uploads then land there) — needs no network, so
  `connect-src` does not stop it [spec: RFC 6265 domain-match].

**Costs.** DNS + tunnel hostname + nginx block as A, no domain purchase; plus, to close the gaps above: rename the
cookies to `__Host-` (forbids `Domain`, so no tossing; logs every web user out once, or a dual-read release) and an
API filter refusing cookie-authenticated unsafe methods with `Sec-Fetch-Site: same-site`/`cross-site`. Both are
backend changes on the auth path, outside V2 and outside the flag.
**Verdict:** A without a domain fee, but it buys two auth changes to be as safe. Not recommended.

A variant: a subdomain of the **admin** domain `textstack.dev`. Cross-site to the app (good), same-site to the admin
panel (admin cookies `SameSite=Lax`, `AdminAuthEndpoints.cs:123-137`). Same problems, aimed at the admin. Rejected.

### C. Same origin, CSP as the only barrier (the dev host as is), hardened

**Hardening available:** none of it adds a layer. No tokens are in `localStorage` already (§2); the cookies are
already `HttpOnly`. The exposure is the cookie-authenticated API through `parent.fetch`, which no storage hygiene
removes. **Costs:** as srcdoc, the app CSP must be widened for the whole app (§2 finding: a nonce, `blob:` in
`connect-src`, `frame-src`, `style-src`, `font-src`) and the ~3.75 MB page ships in the app bundle as a lazy chunk.
**Measured correction (#1219):** as its own same-origin document the cost drops to `frame-src 'self'` and one nginx
location; the page is a served file, not a chunk. The security verdict does not change: the second layer is still
zero. **Rejected** at the time of writing as weakest; the owner since chose the same origin (2026-11-11), in the
own-document shape.

### D. Drop `allow-same-origin` (a real opaque origin)

Without it every section frame gets a **new** opaque origin, so `iframe.contentDocument` is `null` [spec: HTML
"determining the origin", step 1]. foliate is built on direct DOM access: the paginator measures columns and reads
the section document (`paginator.js`, 1,132 lines), fixed layout likewise (`fixed-layout.js`, 319), the overlayer draws
from live `Range`s (175), `view.js` (597) builds CFIs from ranges; our `page.mjs` does word tap, selection and
highlights on those documents. Working opaque would mean a script inside every section document (a nonce'd script
injected into book HTML) and a message protocol for layout, selection, ranges and CFIs: a rewrite of foliate's view
layer, thousands of lines, and a permanent divergence from upstream. Fork changes need the owner's explicit yes;
**information only, not proposed.**

### E. Page as its own document with a `Content-Security-Policy: sandbox` response header

Without `allow-same-origin`: the document gets an opaque origin, and **nested frames inherit the flags** — a child's
creation sandboxing flags are the union of its `iframe` attribute flags and its container document's active flags
[spec: HTML "determine the creation sandboxing flags"] — so every section frame again gets a new opaque origin
[spec] and foliate breaks exactly as in D [exp would only confirm]. With `allow-scripts allow-same-origin` the header
changes no origin and is just hardening: it blocks top navigation, popups, forms and modals for the page **and its
section frames**, and survives a host that forgets the `sandbox` attribute. Precedent in this repo: `/storage/`
already sends a `sandbox` CSP (`textstack.conf:404`). **Adopted inside A**, not an alternative.

Also considered: a `credentialless` iframe (Chromium-only, does not by itself cut same-origin DOM access [exp]) —
not pursued.

### Summary

| | Second layer if a book script runs | App CSP change | Infra | Auth change | Bundle |
|---|---|---|---|---|---|
| **A** separate domain | full (no cookies, no API, no `parent`) | `frame-src` +1 origin | domain, zone, tunnel host, nginx block | none | page leaves app `dist/` |
| B subdomain | partial until `__Host-` + `Sec-Fetch-Site` | `frame-src` +1 origin | zone record, tunnel host, nginx block | two, app-wide | same as A |
| C same origin | none | srcdoc: widened app-wide; own document (measured): `frame-src 'self'` | own document: one nginx location | none | srcdoc: +3.75 MB lazy chunk; own document: a served file |
| D opaque | full | none | none | none | fork rewrite |
| E header sandbox | — (hardening in A) | — | header | — | — |

## 4. Recommendation

**A, with E's header inside it.** It is the only option where a book script that beats the CSP still cannot reach
the account, and it costs no auth change and one line of app CSP. The domain is a small recurring cost against an
app-wide security property; it also makes "the page never runs on the app origin" a build assertion.

**Smallest first slice (ships behind `Features:V2Api`, off in prod):** S1 below — the served page + shim + a local
two-site harness + the cross-origin sandbox run. No domain, no nginx, no route yet; it proves the mechanism before
anyone buys anything.

## 5. What stays the same in every option

- **The page↔host protocol** (README "Host ↔ page contract", lines 284-318) and the page bytes
  (`v2ReaderPage.generated.ts`, its CSP, drift and size checks). The web host keeps the shim pattern: `postMessage`
  out, `{call, args}` in, `openBytes` → `blob:` → `openUrl` (`V2ReaderDevPage.tsx:50-60`).
- **Book bytes on production** come from `GET /me/v2/books/{bookId}/files/{fileId}/content`
  (`V2Endpoints.cs:61-62`, Range-capable `Results.File`, `:144-145`), URL built by `v2Api.contentUrl`
  (`packages/shared/src/api/v2.ts:507`) via `v2FileUrl(bookId)` (`v2Books.ts:130-133`; `''` until the book is known,
  so the host loads the book first). Mapped only with the flag (`V2Endpoints.cs:32`).
- **The host fetches, the frame never authenticates.** The host does `fetch(url, { credentials: 'include' })` with
  the same 401 → refresh → retry-once rule as `authFetch` (`client.ts:11-16`), reads `arrayBuffer()`, transfers it
  (zero-copy) into the frame. The frame URL is constant: no book id, user id or token in it, so nothing private
  reaches the reader origin's logs.

## 6. Slices (stackable PRs, after the decision)

| # | PR | DoD | Tests |
|---|---|---|---|
| S1 | **Served page + two-site harness.** Build step writes `dist-reader/index.html` (generated page, nonce placeholder kept, shim with `__V2_PARENT_ORIGIN__`); a dev static server on `127.0.0.1:5174` doing both substitutions per request; `/dev/reader-v2` embeds it by `src=` instead of `srcDoc`; host/shim check origins; `assert-no-dev-reader` → "no page in `dist/`, page in `dist-reader/`". | Dev route reads every format as today, from the second site. App `dist/` has no `__V2_READER_NONCE__`. | `sandbox.check.mjs` new run: served cross-site, CSP bypassed → zero app reach (§3 A); existing 30/30 + mutations unchanged; `check:v2-reader-formats` through the served page; unit test of the substitution (nonce differs per request, rejects a request without placeholder). |
| S2 | **Infra (owner-gated: domain).** Domain + zone + tunnel hostname; nginx `server` block (one location, headers of §3 A, `sub_filter`, no-store); app CSP `frame-src` += `READER_ORIGIN`; deploy ships `dist-reader/`. | `curl` checks in `health-check.yml`: 200, header CSP, no `Set-Cookie`, two requests → two nonces. Nothing in the app links to it yet. | The `curl` row; nginx config test in CI if one exists, else the deploy's `nginx -t`. |
| S3 | **Prod route behind the flag.** `/:lang/library/my/:id/read-v2` (private, `noindex` by the existing `library/my` rule, `textstack.conf:120`), mounted only when `v2Enabled()`; the dev page's host logic moves into a `V2ReaderHost` component used by both routes; bytes per §5; `openLink`, `word` (stub label), flow setting as today. | With the flag on (dev/CI), an uploaded book opens from the library; with it off the route 404s/redirects to the legacy reader. Dev srcdoc path deleted. | `@v2` e2e: upload EPUB → open → next page → reload → same book opens; one row per format family (EPUB, MOBI, CBZ); host unit tests with a fake frame (origin check, stale answers via `openTracker`). |
| S4 | **Loading, errors, deadlines** (#1080 item 3 for web; ADR-029 D6). States: fetching bytes (progress by `Content-Length`), opening, open-failed (message from the page), 401/404/offline/`v2_unavailable` (503) with retry. `ready` deadline (fixed, e.g. 10 s → "reader failed to load"), `opened` deadline scaled by file size. #1081 is the Android `library.json` path: check it is obsolete after R6 (`hostStorage.ts` imports it once) and close or narrow it; its web twin (`V2ReaderDevPage.tsx:39`, corrupt → empty library) dies with the localStorage library in S3. | Every state reachable and leaves no stale title (#1168 rule). | Unit tests per state with fake timers; e2e: blocked reader origin → deadline screen; 404 file → error. |
| S5 | **Sync on the shared client.** Restore = server state + this book's annotations → the page's entry; `store` → diff → `putReadingState` / `putAnnotation` (`v2.ts:520-531`); ADR-019 newer-position rule via `decideServerState`; `whileCurrent` epoch guard. Shareable as is: `packages/shared/src/reader/v2LocalSync.ts` (`positionWrite` :76, `statePosition` :101, `highlightWrite` :119, `annotationHighlight` :133, `decideServerState` :183) and `v2Api`. Not shareable: `apps/mobile/src/lib/v2reader/sync.ts` (imports `react-native` :13, SQLite `LocalLibrary`, outbox). Extract first: the pure "rows ↔ page entry" mapping inside `createLocalLibrary` (`localLibrary.ts:173`) into `packages/shared`, mobile re-pointed, its tests moved. Web is online-first: no outbox; a failed write retries on the next `store`/`visibilitychange` and shows "not saved". | Position and highlights round-trip web ↔ server ↔ Android. Mobile suite green on the extracted module. | Moved unit tests; web host unit tests on 409 paths; `@v2` e2e: read → reload → same CFI; highlight → second browser context sees it. |

S1 → S3 can merge before S2 exists (the route is dev/CI-only while the flag is off and `READER_ORIGIN` is unset).
S4 and S5 stack on S3; B/C waves of the audit start after S3.

## 7. Owner questions

1. Web host isolation: **A separate domain** / B subdomain + `__Host-` cookies + `Sec-Fetch-Site` filter / C same
   origin with app-wide CSP widening.
2. Reader domain: **buy a new registrable domain** / a subdomain of a public-suffix-listed hosting domain (free; no
   per-response nonce without server code) / a subdomain of `textstack.dev` (shares a site with admin: no).
3. Per-load nonce on a served page: **nginx `sub_filter` with `$request_id`, `no-store`** / hash-based CSP (ADR-029
   D4 change) / cacheable page with a per-response nonce (weaker freshness).
4. Web offline for the V2 reader in wave A: **online-only (bytes fetched per open)** / IndexedDB byte cache now.
5. Route: **new `/read-v2` until R8** / existing `/read` switches on the V2 flag now.
6. Record as **ADR-033 once decided** / keep as a design doc.
7. `Sec-Fetch-Site` check on cookie-authenticated unsafe methods (useful whatever is chosen): **issue now, fix
   later** / fix in wave A / skip.

## 8. Recorded decision: Android WebView floor

**Decided by the owner on 2026-11-11:** an Android System WebView older than 117 gets an "update your WebView" screen,
not the legacy reader (ADR-029 Decision 6 recommendation, `ADR-029-foliate-for-v2-epub.md:97-103`, confirmed; the
detection is the recommendation's: an ES5 user-agent probe before the page loads, with the `ready` deadline of S4's
Android twin as the backstop, #1080). Not copied anywhere yet on purpose: when the Android slice lands, its PR moves
this into ADR-029 Decision 6 (from "Recommendation … the owner's to confirm" to "Decided 2026-11-11") and removes
"the WebView ≥ 117 screen" from `docs/STATUS.md` "Decisions pending from the owner" (line 120).
