# ADR-029 — foliate-js renders V2 EPUBs

**Status:** Proposed · **Date:** 2026-10-30 · **Plan:** [v2-plan.md](../v2-plan.md) §7 · **Amends:** [ADR-025](ADR-025-reader-engine-package.md) (scope: ADR-025 keeps server-chapter reflow and PDF until the V2 reader replaces them; its rejection of foliate is withdrawn for V2 local EPUBs) · **Keeps:** ADR-012 (PDF original-first), ADR-019 (position rules, re-expressed over CFI) · **Builds on:** ADR-031 (locator schemes)

## Context

**Why ADR-025 rejected foliate (2026-10-08).** The reader then showed *server* chapters: the
extraction pipeline turned an EPUB into sanitised HTML per chapter, and the engine only had to lay
that HTML out in a container the host gave it. For that job foliate's model was the wrong shape:
an iframe per section (breaking web popups, selection listeners and keyboard handlers), positions as
CFI against the original package (our stored positions are chapter-slug + text quote), and an API
its author calls unstable. ADR-025 kept borrowing ideas instead — `packages/reader-engine/src/overlay.ts`
is a port of foliate's `overlayer.js` (MIT, © John Factotum).

**What changed.** V2 is local-first ([v2-plan.md](../v2-plan.md) §1.2, Story A): the client owns the
original EPUB file and reads it with no account and no server. The job is no longer "lay out our
HTML" but "open a real EPUB package on the device": OPF, spine, manifest resources, book CSS and
fonts, internal links, then render it. Writing that loader on top of our engine means owning an EPUB
parser, a resource resolver and a pagination model. A maintained open-source engine already does all
three; the parts we must own are position, annotations and the sandbox around it.

**Prototype evidence** ([epub-engine-prototype.md](../epub-engine-prototype.md)) — a separate clone,
reviewed independently on 2026-10-29. Not in this repo.

| Verified in the prototype's code | Reported only in its README (not verified) |
|---|---|
| foliate-js pinned at `78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01); MIT © John Factotum; bundled zip.js BSD-3 | emulator kill/relaunch resumes in place |
| One patch, `patches/0001-paginator-render-while-loading.patch`: `Paginator.render()` returns while `!this.#view?.document?.body` (render during section load), with reproducer `reproRenderDuringLoad` | a 35.8 MB book opens in 4.7 s vs 27.9 s over base64 |
| Build: esbuild IIFE, target `chrome90`, inlined into an HTML string under a nonce CSP (Decision 4) | hostile-book gate passes (its script asserts nothing) |
| foliate's section iframes are `sandbox="allow-same-origin allow-scripts"`, so the CSP is the only script barrier | any physical device run |
| WebView loads with `baseUrl = file://<documents>` + `allowFileAccess` + `allowFileAccessFromFileURLs` (universal access off) and reads the retained EPUB by XHR | |
| Position = `{cfi, quote (64 chars), index, fraction}`, restored only if the text at the CFI still starts with the quote | |
| Highlights = `{cfi, quote, prefix, suffix, color}`; prefix/suffix via reader-engine's `rangeToLocator` | |
| Navigation serialised through a promise queue; pdf/mobi/fb2/cbz/tts/search modules stubbed out (bundle ~216 KB) | |

Prototype defects to fix when porting (R1/R2): the store write is not atomic; the mount effect runs
before the `__DEV__` redirect; the `file://` exposure has had no security review; the check scripts
exit 0 on failure; a fresh clone does not build (the generated page is gitignored).

The production reader deliberately mounts its reflow document with **no** `baseUrl`
(`apps/mobile/src/components/reader/ReaderShell.tsx`, comment on the file-access flags): the
`allowFileAccess*` flags are already WebView-wide there for pdf.js, and the missing file origin is
what keeps user HTML away from the app's files. The prototype's `file://` base gives exactly that
origin to book content, so it cannot inherit the production reader's safety argument.

## Decision

1. **V2 local EPUBs render with foliate-js.** One iframe per section, paginated layout, positions as
   CFI stored in ADR-031's `epub-cfi` envelope (`{"version":1,"scheme":"epub-cfi","value":…}`; the
   envelope had no field for the prototype's quote check — resolved: ADR-031 `epub-cfi` carries
   `quote` since 2026-10-30), with the fraction beside it because CFIs do not sort. The schemes are defined in ADR-031 §"Locator
   schemes"; this ADR does not redefine them.
2. **Pin, patch, attribute.** foliate-js is pinned by commit SHA, not a branch or tag. The bundle is
   built from that SHA with every `patches/*.patch` applied on every build; a patch that no longer
   applies fails the build. A bump is a PR that re-runs every check in Decision 6. Each patch is
   offered upstream; dropping it after an upstream fix is part of the next bump. Licence notices are
   kept in the output (`legalComments: 'inline'`). Notices this bundle carries:
   - foliate-js — MIT, © John Factotum
   - zip.js (bundled by foliate-js) — BSD-3-Clause
3. **The reader page is a build artifact.** esbuild IIFE → committed `v2ReaderPage.generated.ts`
   with a CI drift check — the pattern of `apps/mobile/src/lib/pdfViewerScript.generated.ts` and
   `apps/web/scripts/mobile-bundles.mjs`. ADR-025's 64 KB budget does **not** apply: it bounds our own
   engine so a hotfix always fits, while this bundle is a vendored EPUB stack (parser, zip, paginator,
   overlayer) at ~216 KB with the unused format/TTS/search modules already stubbed out. It gets its
   own size assertion at its first committed size, raised only by a deliberate PR.
4. **Sandbox: the CSP is the contract.** Because the section iframes allow scripts and same-origin,
   the page's CSP is the only thing between a book and script execution:
   `default-src 'none'; script-src 'nonce-…'; style-src blob: 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src blob:; connect-src blob: data: file:; form-action 'none'; base-uri 'none'`.
   Book scripts never run; book resources load only as `blob:`/`data:`. Removing or widening a
   directive is a change to this ADR. The `file://` base URL with direct XHR read of the retained
   file is **accepted only for the dev route** until the R4 security review decides (keep, narrow
   `connect-src file:` to the one file, or hand bytes in another way).
   **R4 recommendation (2026-10-30), owner to decide:** hand the bytes in another way, natively — an intercepted
   https origin (`shouldInterceptRequest` / `WebViewAssetLoader`) serving only `books/<sha256>.epub`, a non-`file:`
   base URL, both `allowFileAccess*` flags off, `connect-src` path-restricted to that URL — before any non-dev route;
   `file://` stays accepted for the dev route until then. Why: behind the nonce, one script in this origin reads the
   app's whole data dir (listings of `files/`, `databases/`, `shared_prefs/`; AsyncStorage; the offline SQLite)
   and the `openLink` bridge can carry it to a browser — measured on the emulator. Narrowing is not expressible
   (Chromium rejects a `file:` path as a CSP source); bytes over the bridge would take ~68 s for an 87 MB book
   against 6.4–7.7 s by XHR. Trade-off: native code in `react-native-webview`. Evidence: [R4 security review](../epub-engine-prototype.md#gate-file-security-review).
5. **Dev-only first.** One `__DEV__`-gated route (R2: `app/dev/epub-v2.tsx`); the release bundle
   contains no reader page and no route to it. No production route until every gate below passes.
6. **Gates to leave dev-only** (prototype brief + plan R3/R4), recorded as an evidence table in
   `epub-engine-prototype.md` and summarised back here:
   - a physical Android device (not only the emulator);
   - a book of at least 80 MB;
   - a real out-of-space (ENOSPC) failure during import, with no half-written state;
   - the oldest supported system WebView. The `chrome90` target means stock Android 7–9 WebViews
     fail to run the page: decide between an explicit "update Android System WebView" screen and a
     lower target. **Recommendation (2026-10-30), the owner's to confirm:** the update screen, gated on
     Chrome ≥ 117 — the page's real floor (foliate calls `Object.groupBy`), whatever the esbuild target —
     detected without booting the page (an ES5 user-agent probe or a `ready` deadline), keeping `chrome90`.
     A lower target alone cannot work (esbuild does not polyfill APIs); lowering plus polyfills costs ~10 %
     bundle and a polyfill list every foliate bump can outgrow, and stock Android 7–8 stay out anyway;
   - a security review of the `file://` access (Decision 4);
   - a hostile-book check that **asserts** and exits non-zero (R3: SVG script, `<base>`, `<embed>`,
     `srcdoc`, meta refresh, `file://` sibling read), and fails when a CSP directive is removed.

   **R4 evidence (2026-10-30)** — the table is in [epub-engine-prototype.md](../epub-engine-prototype.md#r4-adoption-gates--evidence-2026-10-30):
   - Physical device: **not run**, owner (device, pending).
   - 80 MB book: **pass** on the emulator — a real public-domain book padded with rendered PNG plates to 87 MB opens
     in 6.4–7.7 s and restores its position after a kill.
   - ENOSPC: **partial** — never an entry without its file and `staging/` is always cleaned, but a failed
     `library.json` write leaves an orphan retained copy and empty `.tmp` files (host fixes listed there).
   - Oldest WebView: **fails on WebView 66** (syntax error before `ready`; the host waits forever); real floor
     Chrome 117; recommendation in the WebView bullet above.
   - `file://` review: written; recommendation under Decision 4, owner to decide.
   - Hostile book: **pass** — R3 in CI (30/30 blocked, 9/9 mutations caught); re-run on the emulator's Android System
     WebView through the dev route: 30/30 blocked, with a positive control (CSP bypassed: 21/30 escape).
7. **Positions: legacy frozen, V2 on ADR-031.** ADR-025's stored shapes (`TextPosition` v1,
   `TextAnchor`, `PdfAnchor`, `page:<N>`, `chapter:<slug>`) stay frozen for legacy data and keep their
   byte-identical round-trip fixtures; V2 writes only ADR-031 schemes. ADR-019's rules are kept —
   per-doc key, restore once when ready, a frontier, server data only as a newer-check
   (adopt / move / ask, never yank a reader who moved), deadlines on every wait — but keyed by
   **spine index + CFI** instead of chapter slug. That re-keying is the one behaviour this ADR does not
   specify; R6 re-specifies it with a pinning test per rule.
8. **PDF unchanged.** The pdf.js original-first viewer (ADR-012) and its `fixed` layout in
   reader-engine stay. V2 only wraps it in `books`/`book_files` with `pdf-page` locators (R7).

## Consequences

**Positive**
- We stop owning EPUB parsing, resource resolution and pagination for V2; the server no longer has
  to read a book for the client to read it.
- Book CSS, fonts, images and internal links render as the publisher made them, offline.
- Positions survive font and viewport changes by construction (CFI + quote check), not by our
  re-anchor code.

**Costs**
- **Two renderers coexist until R8:** reader-engine for server chapters and PDF, foliate for V2
  EPUBs. Bugs in selection, highlight and word-tap behaviour must be fixed in whichever path the
  book uses.
- **An unstable upstream API.** Every bump re-runs all Decision 6 checks; patches are a maintenance
  line item, not hidden in an adapter.
- **iframe-per-section breaks ADR-025's no-iframe rule** for this path: the selection, word-tap,
  inline-translation and vocabulary overlays must be rebuilt inside foliate's overlayer and its
  per-section documents, not reused from reader-engine's container model.
- **Paginated, not scroll** — the opposite of ADR-025 decision 3; code blocks and wide tables in
  technical books will split across pages.
- **"The engine never fetches" (ADR-025 decision 6) does not hold** for the prototype's page, which
  reads the EPUB by XHR. Whether it stays that way is part of the R4 security review.
- **Bundle size** ~216 KB per open, outside reader-engine's budget.
- **A `chrome90` floor** excludes old stock WebViews unless the target is lowered (Decision 6).

## Alternatives considered

- **Keep reader-engine and write an EPUB package loader in front of it** (the prototype brief's
  outcome 2). Keeps one renderer, scroll layout and today's overlays. Rejected: we would own an OPF/
  spine/resource parser, CSS and font scoping and internal-link resolution — the parts an engine
  gives for free — and position would still be chapter-relative to HTML we produced.
- **Another open-source EPUB engine.** The other candidates of this class also render sections in
  iframes; ADR-025 already found one without re-anchoring on resize and without PDF. foliate-js is
  the one already partly ported (`overlay.ts`), small enough to vendor and patch, and has prototype
  evidence. Rejected for now; revisit only on concrete blocking evidence from the gates.
- **Server-side extraction to chapters, as today.** Already built and in production. Rejected for
  V2: it needs the server to read the book before the client can, which contradicts local-first
  reading with no account (Story A). It survives as the transitional `book_chapters` path until R8.

## Rollback

- **While dev-only:** delete the route and the generated page. Nothing user-facing or stored changes.
- **After a production route:** a flag sends V2 EPUBs back to the legacy reader, which works only
  while `book_chapters` exists and the server can still extract the file. **R8 (retire the legacy
  reader, drop `book_chapters`) is therefore the point of no return** and must wait until R4 (gates),
  R6 (position rules over CFI) and R7 (PDF on the V2 path) are done.
