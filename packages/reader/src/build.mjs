// Builds the V2 reader page (ADR-029): pinned foliate-js fork + page.mjs → one IIFE inlined into an
// HTML string under the book-sandbox CSP → readerPage.generated.ts (committed). The MOBI, FB2, CBZ
// and PDF readers (and pdf.js's cMaps) are IIFEs of their own, carried as strings and run only when a
// book of that format opens (README, Formats).
//
//   node build.mjs           write readerPage.generated.ts   (pnpm -C apps/web build:reader)
//   node build.mjs --check   exit 1 if the committed file differs or the page outgrew its budget (CI)
//   node build.mjs --repro   also write .vendor/readerPage.repro.html: the page + repro.mjs (test only)
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANDROID_CSP, CSP, NONCE, formatsJs, html } from './carrier.mjs'

// Pinned by SHA on our fork (ADR-032): upstream 78914aef (2026-05-01, no releases, unstable API)
// + our patches as real commits. MIT © John Factotum. A bump is a PR that re-runs every ADR-029
// Decision 6 check.
// The pin is fetched from the GitHub fork; CI never sets anything else. FOLIATE_REPO (env) is a LOCAL-DEV override only:
// a clone (a path) holding a fork commit not pushed yet, so a fork change can be built and checked before its push. The SHA
// still decides what is built, wherever it comes from; push the fork commit before the PR, or CI's fresh clone fails.
const FOLIATE_REPO = process.env.FOLIATE_REPO || 'https://github.com/mrviduus/foliate-js.git'
// Branch textstack-pin: 78914aef + d73682a (paginator render-while-loading) + #1182: typed KF8 resource
// blobs, KF8 sections through transformTarget, view relocate carries `reason`, PDF null outline
// destination (upstream ce10f08), PDF nothing at import time (pdf.js is stubbed out of the page),
// paginator: setStyles' frame callback does nothing once destroy() nulled the view; #1291: nor does
// afterScroll (the debounced scroll listener outlives a closed book); #1297: justAnchored swallows only the
// anchoring's own scroll, not the reader's next one; #1315: search takes a `limit` (matching, registering and
// drawing stop at it), each hit carries the contents entry it is under, a section that throws is skipped and
// reported, and a hit over several text nodes keeps its middle; #1203 (branch pdf-adapter-fixes-1203): the PDF link
// service has getAnchorUrl and the other IPDFLinkService no-ops, render() replaces its layers, the last four pages kept
// (older ones revoked and cleaned up), a failed load destroys its own task, TOCProgress resolves entries in parallel;
// #1204/#1557 (branch pdf-worker-wasm-1204): the bytes handed to pdf.js once (`data`), a host-made worker per document
// terminated past a deadline, OpenJPEG's wasm vendored, the outline after open (`getTOC`, `view.updateTOC`), a page's
// blob: URL kept until its frame has loaded it; a page's calls on a budget of their own (`pageDeadline`), a terminated worker
// reported (`onFail`); then (#1579 review) one watchdog on the worker's silence instead of per-call timers (`silence`), a
// render no longer wanted cancelled; a page that fails to draw, or a worker that dies, the book stopped;
// #1333 (branch turn-cause-1333): a section crossed by the reader's own turn (#turnPage, a swipe's snap) relocates
// with reason 'turn', not 'navigation'; a scrolled prev/next with 'page' and a fixed layout's goTo with 'navigation' (both
// none before), view history kept for 'turn'; a view still loading relocates nothing (its expand no longer repeats the
// crossing's place first), the anchor of a turn set before the load (a navigation's: 0), no visible range of the old
// document kept through it.
// #1585 (branch pdf-cap-1585, on #1333's): pdf.js's worker caps what one stream decodes to at 384 MiB (a local patch to
// vendor/pdfjs/pdf.worker.mjs, re-applied on a pdf.js update), so a page bomb is `book-stopped` before Android kills the WebView,
// a stream past it refused at once after; an image over 80 M px skipped (`maxImageSize`).
const FOLIATE_SHA = 'c18e1898a8a3b4201b48ecff0b2dc5c6055a958e'
// Unminified characters of the bundled script: a tripwire at the committed size, not a ceiling. Any
// growth fails --check until the PR that grows the page raises it (ADR-029 Decision 3). Not
// the retired reader engine's 64 KB budget.
// +319 (M2.7a, #1112): notInSurrogatePair, so a quote or its context never carries a lone surrogate V2 refuses.
// +854 (#1078): v4 UUID ids from getRandomValues, quotes cut by code points, selectedText beside quote,
// highlights refused with no text or over SyncLimits.MaxSelectedText.
// +5602 (#1128): routing by content (formats.mjs), the format-reader runner, CBZ without text features
// and with a `page` position, MOBI6 refresh strip, flow() validation and the reader-flow telemetry.
// Excludes the carried format readers below (their strings sit ahead of this script).
// +3136 (#1128 review): sniff before teardown, KF8 refused / combo read as MOBI6, truncated MOBI, UTF-16
// FB2 re-encoded, FB2 entities refused, CBZ names/types/dedupe, flow() not a switch on a fixed layout.
// −418 (#1128 simplify): no UnsupportedBook class, one FB2 head decode, one image-extension list, slimmer
// telemetry session, CBZ aliasing in one loop.
// +1353 (#1187): a fraction-only position (transitional server locator) restored and gone to by
// fraction, with no save until the reader moves away from where it landed.
// +651 (#1187 QA): the hold kept through a re-layout (the renderer's relocate reason), a fresh navigation
// chain per open (a goTo in flight no longer wedges the next book); `quiet` dropped.
// +643 (#1187 round 2): one save rule (reason + previous CFI) for every relocate, a taken fraction offer
// saved as a CFI, arrival checked for every fraction navigation, fraction 0 = text start, calls bound to
// the view (viewSeq) instead of the open seq; the fraction predicate now comes from packages/shared.
// +773 (#1187 round 3): one host-move guard (restore + non-chosen goTo save and echo nothing), restore
// as one navigation slot, restore only for a view that answered `opened`, one position builder,
// fixed-layout arrival by spread.
// +575 (#1182 pin bump): KF8 read — formats.mjs checks the KF8 header (an AZW3's own or a combo's KF8
// half) for DRM and SKEL/FRAG indexes before teardown, combos no longer forced to MOBI6 (withoutKf8 gone);
// view.js forwards the relocate reason (+15), the page's capture listener for it is gone.
// +43 (#1182 guard commit): paginator setStyles' frame callback returns once destroy() nulled the view.
// +2534 (#1128 S5): PDF routed to the pdf reader with its cMap reader, `pdf-page` positions (page =
// section index + 1) built, restored and gone to, the scheme-fits-the-file guard on restore and goTo,
// `annotatable` (PDF highlight/translation refused, no CFI in its word taps), the book made before the
// open one is torn down (a failed make leaves it reading and gives the seq back).
// +1035 (#1128 S5 fix round): open lifecycle — listeners, restore and `restored` bound to the view on screen
// (`viewSeq`), the open seq only goes up (no give-back), replaced/superseded/empty builds and failed PDF loads
// destroyed, the pending save flushed at the swap, zero-section books refused, a raw CFI goTo refused on a PDF.
// +851 (#1128 S5 review): a book still on screen after its init answers `opened` (viewSeq, not the latest
// attempt), `restored` carries its key, goTo refuses a page past the end, arrival never through a missing
// section, the structuredClone refusal, PDF outline entries that reject go nowhere.
// +63 (#1226): the entry checks moved to packages/shared/src/reader/pageStore.ts (one home for the page and both
// hosts); the bundle's module-path comment line is the growth, the code is the same.
// +791 (#1226): `addHighlights(list)`, the web host's highlights drawn after the restore without moving the reader;
// +350: its `highlights` answer, one status per item.
// +6303 (#1268): the `selection` / `selection-cleared` messages — one selection at a time across the shown section
// documents, re-sent (box only) on relocate, scroll and resize, clipped to the viewport, trimmed range, rendered
// text, sentence of a range, the frame's scale (`word` too), a press dismissing a selection, cleared at the swap,
// `highlightSelection` of the live selection (else the one sent), one description for both; packages/shared's text
// cap and `clip`.
// +1446 (#1263, #1264): `tap` carries where it landed, `opened` the reading direction, `key` forwards the navigation
// keys (a closed list, chrome.mjs), `flush()` and a flush on hidden / pagehide.
// +742 (#1263 review): `tap` from the page's own document (margins, letterbox), keys forwarded from it too, only on
// the document itself (no control, no Shift+arrow) with `repeat`, `dir` as the renderer pages (`pagedDir`) on `relocate` too.
// +7 (#1263): `relocate.moved`, the save rule's own test sent to the hosts.
// +35 (#1291): the fork's afterScroll guard.
// +1493 (#1261, #1262, #1266): `opened.toc[].depth`, `relocate.tocIndex`, `relocate.atEnd` (atBookEnd),
// `relocate.sectionEnd` and `relocate.words` (lengthAt).
// +3227 (#1260): `settings(raw)` — settings.mjs (closed lists, a clamped size, the section stylesheet: size, family,
// line height, alignment, theme), the page's own colours by theme, OpenDyslexic's blob: URL from its chunk; `font(±)`
// is now `settings` with one field changed.
// +284 (#1260 review): the `book` alignment (the default: no text-align of ours), string-only closed lists, a light
// plate under images and inline SVG in dark.
// +773 (#1269): `opened.lang` (the book's language, for the word popup's translation) and `clearSelection()` (the
// host's toolbar closed after an action: the selection gone, `selection-cleared` at once).
// +173 (#1286): `flush()` returns the latest `store` (pending or already sent), read synchronously by the web host.
// +177 (#1286 review): the swap forgets the previous open's last store (`saves.forget()`).
// +484 (#1196): a pre-paginated EPUB saves a named page (`pageForm`, `pageKey`), and `land()` goes to a named page by
// its name, not by the CFI its index rebuilds (CBZ too).
// +491 (#1196 review): a taken goTo on a fixed layout saves the side shown; restore picks a named page by its shape;
// `sectionNamed` takes the position's index when it names that page.
// +5176 (#1312): highlights in four colours (highlights.mjs, drawn by colour), `recolorHighlight`, `removeHighlight`,
// a tap on a highlight (`highlight-tap`), the drawn list in book order (`highlight-list`, foliate's CFI compare); a highlight
// ends its selection at once (`endSelection`, shared with `clearSelection`); ranges of unloaded sections pruned
// (`pruneDrawn`), `drawnRanges()` a test-only count; the same range highlighted again is that highlight (`sameRangeHighlight`).
// No re-key on the page: a re-keyed highlight keeps its old id here
// until the next open, the hosts resolve it.
// +879 (#1272): `speaking(cfi, index)`: the range the host speaks underlined in SPOKEN_FILL (listen.mjs) until
// `speaking(null)`; one decoration of an overlay goes without the others (`undecorate`).
// +164 (#1297): the fork's justAnchored keeps the anchored scroll offset, swallowing only the anchoring's own scroll.
// +1991 (#1313): `relocate.cause` (turn / nav / layout) from the page's own navigations (`asNav`: a restore, a host goTo,
// section(), a followed link through the page's chain; reset at the swap, bounded at 15 s except a restore), the open
// awaiting its restore unless the reader acts (`awaitingRestore`, `readerActed` from any input or a turn);
// `__testHoldNav(ms)` and `__testRestoreDelay(ms)` test-only.
// +8748 (#1265): the image lightbox (lightbox.mjs): an EPUB image tapped in the middle zone opens full screen in the page's own document,
// pinch / wheel / double-tap zoom about the focus, drag to pan, clamped; Tab kept; `closeLightbox()`, `lightbox` on open and close.
// +778 (#1267): `labels({image, close})`: the lightbox's two words from the host (`readLabels`: non-blank strings, capped).
// +7,385 (#1271): `markWords(words, show)`: saved-word marks by stage, placed per section (wordMarks.mjs).
// +10,357 (#1315): in-book search. The fork's search.js is no longer stubbed out (its matchers and excerpts, about
// 5,700 of it: view.js's `search` was in the page all along, importing a stub), plus `search(query, id)`: one search
// at a time, streamed per section in `search-results`, stopped one hit past the cap by the fork's `limit` (`more` only
// for that hit), every hit drawn (search.mjs), a section that cannot be read skipped by the fork and reported
// (`incomplete`), the query counted in characters (one is enough where words have no spaces); `opened.searchable`.
// The fork's 686afc4 (limit, per-hit label, skipped section) is about 500 of it. The book's own language is the
// search's locale, and a search ended between sections reads no further one.
// +14,601 (#1316): `relocate.chapterEnd` / `chapter-end` (the chapter whose last drawn line is on screen, by the document's
// order: chapters.mjs `startsIn`, `segmentsIn`, `fileSummary`; page `chapterEndNow`, `lastInk`, `endOnScreen`, `carryInto`,
// `endsWithFile`; where the contents lead, found out after `opened`: `startChapters`, `refineChapterEnd`) and
// `chapterText(request, tocIndex, section)` → `chapter-text` (an entry's text from the book's own section documents, the
// same rule: `textBetween`, `fitText`, the 200 KB share cap; text.ts `textNodes`).
// +6,054 (#1314): bookmarks (bookmarks.mjs): `addBookmark()`, `removeBookmark(id)`, the `bookmark-list` message (the list, the
// one on screen, whether one can be made here); kept in the entry as highlights of colour `bookmark`, never drawn.
// +2,756 (#1314 review): `here` by the live layout (bookmarks.mjs `atTop`, `lineCount`), kept while the reader has not moved;
// `can` only once bookmarks are placed (`restore(json, more)`); the list cached; `opened.bookmarkable`; text.ts helpers.
// +459 (#1314 review 2): the bookmark label made for bookmarks only, never failing a restore; `bookmark-list.placing`.
// +119 (#1069): stamp opens before the XHR and ignore superseded read success/failure callbacks.
// +4,734 (M5, owner decision 5; #1195): HTML clips as one sanitized section (clip.mjs); legacy anchor
// annotations listed as quotations (`quotations` in the entry or `addHighlights`, never drawn nor stored).
// +254 (#1362 review): a clip opened only by the host's format (`openUrl(url, name, 'html')`, no sniff), data: images
// only (alt text otherwise), loops instead of spreads, quotations reset with the entry.
// +343: `pointer-move` (a mouse over the book, throttled) for the web host's bars on desktop.
// +4,282 (#1426): `describe(id, url?)` → `described` (describe.mjs: `bookMeta`, `coverJpeg`), a book's details and cover
// from a file of its own or the book on screen.
// +1,017: explicit alignment wins over publisher CSS and restores the book's original rules.
// +2,052: embedded brand fonts and explicit font choice in book sections.
// +63: theme-specific edge shading on the reader shell.
// +960: safe text viewport insets and live, user-initiated scroll positions for mobile controls.
// +566: saved quotations reuse anchored annotations without painting text.
// +174: keep placed quotations separate from bookmark state.
// +2,472: the contents the server keeps, sent in `described` (ADR-033 P3, chapters.mjs `tocEntries`).
// −276 (#1203 pin bump): the page no longer wraps pdf.js's getDocument (the fork destroys a failed load's task);
// progress.js resolves TOC entries in parallel.
// +407: saved words' translations get room above them (line height +0.4 while some show) and show their first meaning.
// +162: the serif faces come in two families (TextStack, then Literata).
// +167: a newer open aborts the previous download and stops its hash (#1177).
// +2,230 (#1204, #1557): pdf.js in a Worker per PDF (`pdfWorker`, a blob: URL of the carried `pdfworker`), its deadline (the
// open's, deadlines.mjs; `__testPdfDeadline`), OpenJPEG's wasm from its chunk (`PdfWasm`), the bytes handed over once, the outline
// after `opened` (`toc`, `view.updateTOC`; describe asks for it).
// +318 (#1204 review): a page's own budget (PDF_PAGE_MS) and `book-stopped` when the worker of the book on screen is terminated.
// −99 (#1579 review): one silence watchdog (PDF_SILENCE_MS) for the deadlines; `toc` and `book-stopped` said again after a
// newer open fails (`said`); a missing worker chunk fails at once; one base64 helper (`fromBase64`).
// +163 (#1352): a relocate's text nodes and chapter starts cached per section document; one section-end test.
// +455 (#1354): a mark not starting on screen is never asked (`hereOf`, but one above in scrolled flow); `atTop` decides a
// mark on a line below the place's by first lines (no span; the place's measured once, on demand); `bookmark-list` carries
// its list only when it changed (`listSent`); text.ts `textPartsIn` / `brBetween` shared with tap.mjs.
// +838 (#1333): the fork tags every move (a crossing 'turn', a scrolled page 'page', a fixed layout's goTo 'navigation') and a
// loading view relocates nothing, anchored to its start for a navigation, with no visible range of the old document; the
// page reads `cause` from the renderer's reason (`causeOf`), a turn even while a navigation lands.
// +2,043 (#1350): page bookmarks on a PDF, a CBZ and a pre-paginated EPUB (`marksPages`, `pageOf`, `foundAt`;
// bookmarks.mjs `pageBookmarkText`, `pageBookmarkOn`), a PDF goTo to one's CFI.
// +204 (#1350 review): the side of a spread a goTo landed on (`landedPage`); a CBZ page labelled by number alone.
// +124 (#1350 review 2): a resize forgets `landedPage` (foliate re-renders the side it calls current).
const BUDGET = 354665
// The same tripwire per format reader (#1128): unminified characters of each one's own IIFE, carried
// as a string in the page and run only when a book of that format opens. EPUB is the page itself.
// mobi = mobi.js + vendor/fflate.js; fb2 = fb2.js; cbz = comic-book.js (zip.js is the page's own).
// mobi +264 (#1182 pin bump): typed KF8 resource blobs, KF8 section markup through transformTarget.
// pdf (#1128 S5) = fork pdf.js + pdf.js v5.5.207 (pdf.mjs + pdf.worker.mjs, run on the page's main thread)
// + its two layer stylesheets, the one MINIFIED reader (keepNames; 1614390 without them, 3180221 unminified): the measured
// size. pdf +1825 (#1128 S5 review): pdfPolyfills.mjs first (runtime APIs an older WebView lacks).
// pdf +936 (#1203 pin bump): the link service's no-ops, layers replaced per render, pages released, a failed load's task destroyed.
// pdf −1,231,045 / pdfworker +1,234,278 (#1204): pdf.worker.mjs moved to a chunk of its own, run in a Worker (polyfills first
// there too, MINIFIED); the fork's worker, deadline, bytes-once, lazy outline and per-load page URLs. Together +3,233.
// pdf +98 (#1204 review): the fork's `pageDeadline` and `onFail`, a render the terminated worker never answers ends quietly.
// pdf +279 (#1579 review): the fork's silence watchdog in place of per-call timers; a render no longer wanted cancelled.
// pdf +116 (#1579 emulator): a page that fails to draw, or a worker that dies after the load, is the book stopped.
// pdfworker +659 (#1585 pin): pdf.js caps what one stream decodes to (384 MiB), a stream past it refused at once after.
// pdf +55 (#1585): the fork's maxImageSize (80 M px); the polyfilled stream iterator cancels its stream when a loop
// leaves early, as the spec's does.
// pdfwasm (#1204) = OpenJPEG's openjpeg.wasm (250009 bytes) as base64 + its two BSD notices, run only for a JPEG 2000 image.
// pdfcmaps (#1128 S5) = pdf.js's 168 predefined cMaps as base64, run only when a PDF names one.
// dyslexic (#1260) = OpenDyslexic-Regular.woff2 (115280 bytes, the file the web app serves) as base64 + its OFL
// notice, run only when the reader picks that family. Not a reader; it rides the same carrier.
// serif: Literata's four full Latin/Cyrillic faces and OFL notice, plus the Latin-only brand font's four (English in TextStack).
const FORMAT_BUDGET = { mobi: 52048, fb2: 11417, cbz: 2030, pdf: 478984, pdfworker: 1234937, pdfwasm: 336968, pdfcmaps: 1559883, dyslexic: 158436, serif: 880055, sans: 525327 }

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'readerPage.generated.ts')
const vendor = resolve(here, '.vendor/foliate-js')
const git = (...args) => execFileSync('git', ['-C', vendor, ...args], { stdio: 'inherit' })

if (!existsSync(vendor)) execFileSync('git', ['clone', '-q', FOLIATE_REPO, vendor], { stdio: 'inherit' })
// Fetch by URL, not remote name: a .vendor/ cloned before the fork switch still has upstream as origin.
git('fetch', '-q', FOLIATE_REPO, FOLIATE_SHA)
// Local modifications (e.g. from the old build-time patching) are dropped BEFORE the checkout:
// a checkout onto a different SHA refuses to overwrite them.
git('checkout', '-q', '--', '.')
git('checkout', '-q', '--detach', FOLIATE_SHA)
// An untracked file could be bundled into the page. Deleting it would silently eat someone's experiment,
// so the build stops and names it instead (CI clones fresh and never meets one).
const untracked = execFileSync('git', ['-C', vendor, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean)
if (untracked.length) {
  console.error(`[v2-reader] untracked files in ${vendor}:\n  ${untracked.join('\n  ')}\nThey could end up in the page. Delete .vendor/ to rebuild from the pin.`)
  process.exit(1)
}
// esbuild is the one the mobile engine bundle already uses (apps/web): no new dependency. Resolved from
// apps/web and version-checked, because the root has another copy — building with it produces a
// different bundle from the committed one, which reads as drift and is not.
const webPackage = resolve(here, '../../../apps/web/package.json')
const { build, version } = createRequire(webPackage)('esbuild')
const wanted = JSON.parse(readFileSync(webPackage, 'utf8')).devDependencies.esbuild.replace(/^[^\d]*/, '')
const minor = (v) => v.split('.').slice(0, 2).join('.')
if (minor(version) !== minor(wanted)) {
  console.error(`[v2-reader] esbuild ${version} is loaded, but apps/web asks for ${wanted}. Run pnpm install.`)
  process.exit(1)
}

// view.js's makeBook lazily imports every format. The page never calls it (page.mjs routes a file
// itself), so its imports are stubbed out of the page: MOBI/FB2/CBZ come in as FORMATS below, and
// PDF too (its own reader below, with pdf.js), TTS not at all. search.js stays in (#1315: view.search).
const stubFormats = {
  name: 'stub-formats',
  setup(b) {
    b.onResolve({ filter: /\/(pdf|mobi|fb2|comic-book|tts|vendor\/fflate)\.js$/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {}', loader: 'js' }))
  },
}

// Each format reader: what page.mjs needs from the fork, registered on window.__tsFormats when run.
// Imports resolve against this directory (the stdin entry has no file of its own).
const fontChunk = (name, dir, files, notice = '') => `${notice}window.__tsFormats.${name} = ${JSON.stringify(Object.fromEntries(
  Object.entries(files).map(([face, file]) => [face, readFileSync(resolve(here, dir, file)).toString('base64')])))};`
const pdfjsNotice = readFileSync(resolve(vendor, 'vendor/pdfjs/pdf.mjs'), 'utf8').match(/^\/\*\*([\s\S]*?)\*\//)[1].replace(/\*\//g, '* /')
const FORMATS = {
  mobi: `import { MOBI } from './.vendor/foliate-js/mobi.js'
import { unzlibSync } from './.vendor/foliate-js/vendor/fflate.js'
window.__tsFormats.mobi = { MOBI, unzlibSync }`,
  fb2: `import { makeFB2 } from './.vendor/foliate-js/fb2.js'
window.__tsFormats.fb2 = { makeFB2 }`,
  cbz: `import { makeComicBook } from './.vendor/foliate-js/comic-book.js'
window.__tsFormats.cbz = { makeComicBook }`,
  // pdfPolyfills.mjs first (runtime APIs an older WebView lacks; esbuild lowers syntax only). pdf.js's worker is NOT
  // here: it is `pdfworker`, run in a real Worker (#1204). pdf.js's
  // Apache-2.0 notice opens with @licstart, which esbuild does not keep when minifying: restated as a /*! */.
  pdf: `/*! ${pdfjsNotice} */
import './pdfPolyfills.mjs'
import { makePDF } from './.vendor/foliate-js/pdf.js'
import text from './.vendor/foliate-js/vendor/pdfjs/text_layer_builder.css'
import annotation from './.vendor/foliate-js/vendor/pdfjs/annotation_layer_builder.css'
window.__tsFormats.pdf = { makePDF, css: text + '\\n' + annotation }`,
  // pdf.js's worker (#1204), the polyfills first (a Worker has its own globals): never run on the page. page.mjs makes
  // a blob: URL of this text and a Worker of it per PDF (CSP worker-src blob:), terminated with the book or past its
  // deadline, so a parse that never ends (a decompression bomb) leaves the page answering.
  pdfworker: `/*! ${pdfjsNotice} */
import './pdfPolyfills.mjs'
import './.vendor/foliate-js/vendor/pdfjs/pdf.worker.mjs'`,
  // OpenJPEG's wasm (#1204; BSD-2-Clause, pdf.js's build of it BSD-2-Clause), base64: run only when a PDF has a JPEG 2000
  // image. pdf.js's worker asks the page for it (PdfWasm in page.mjs, its WasmFactory): no URL, nothing fetched;
  // compiling it is the CSP's 'wasm-unsafe-eval'.
  pdfwasm: `/*! ${['LICENSE_PDFJS_OPENJPEG', 'LICENSE_OPENJPEG'].map((f) => readFileSync(resolve(vendor, 'vendor/pdfjs/wasm', f), 'utf8')).join('\n').replace(/\*\//g, '* /')} */
window.__tsFormats.pdfwasm = { 'openjpeg.wasm': ${JSON.stringify(readFileSync(resolve(vendor, 'vendor/pdfjs/wasm/openjpeg.wasm')).toString('base64'))} }`,
  // pdf.js's predefined cMaps (Adobe, BSD-3-Clause), base64 by name: nothing outside the file is fetched,
  // so they ride in the page like a reader, run only when a PDF's font names one (CJK text).
  pdfcmaps: `/*! ${readFileSync(resolve(vendor, 'vendor/pdfjs/cmaps/LICENSE'), 'utf8').replace(/\*\//g, '* /')} */
window.__tsFormats.pdfcmaps = ${JSON.stringify(Object.fromEntries(readdirSync(resolve(vendor, 'vendor/pdfjs/cmaps')).filter((f) => f.endsWith('.bcmap')).sort()
    .map((f) => [f.slice(0, -'.bcmap'.length), readFileSync(resolve(vendor, 'vendor/pdfjs/cmaps', f)).toString('base64')])))}`,
  // OpenDyslexic (#1260; SIL OFL 1.1, its notice restated), the woff2 the web app serves, base64: run only when
  // the reader picks that family, then a blob: URL of the page's own (font-src blob:).
  dyslexic: `/*! ${readFileSync(resolve(here, '../../../apps/web/public/fonts/OpenDyslexic-LICENSE.txt'), 'utf8').replace(/\*\//g, '* /')} */
window.__tsFormats.dyslexic = { woff2: ${JSON.stringify(readFileSync(resolve(here, '../../../apps/web/public/fonts/OpenDyslexic-Regular.woff2')).toString('base64'))} }`,
  serif: fontChunk('serif', '../..', {
    regular: 'reader/assets/fonts/Literata-Regular.woff2', bold: 'reader/assets/fonts/Literata-Bold.woff2',
    italic: 'reader/assets/fonts/Literata-Italic.woff2', boldItalic: 'reader/assets/fonts/Literata-BoldItalic.woff2',
    ...Object.fromEntries(['Regular', 'Bold', 'Italic', 'BoldItalic'].map((f) => [`brand_${f[0].toLowerCase()}${f.slice(1)}`, `../apps/web/src/assets/fonts/TextStack-${f}.woff2`])),
  }, `/*! ${readFileSync(resolve(here, '../assets/fonts/Literata-LICENSE.txt'), 'utf8').replace(/\*\//g, '* /')} */\n`),
  sans: fontChunk('sans', '../../../apps/mobile/assets/fonts', {
    regular: 'SourceSans3-Regular.woff2', bold: 'SourceSans3-Bold.woff2', italic: 'SourceSans3-It.woff2', boldItalic: 'SourceSans3-BoldIt.woff2',
  }, `/*! ${readFileSync(resolve(here, '../../../apps/mobile/assets/fonts/SourceSans3-LICENSE.md'), 'utf8').replace(/\*\//g, '* /')} */\n`),
}
/** Minified (the only ones): pdf.js is half its size so. keepNames: pdf.js reads `constructor.name`. */
const MINIFIED = new Set(['pdf', 'pdfworker'])

const bundle = async (entry, minify = false) => (await build({
  ...(entry.endsWith('.mjs') ? { entryPoints: [resolve(here, entry)] } : { stdin: { contents: entry, resolveDir: here, sourcefile: 'format.mjs' } }),
  // Fixed, because esbuild writes source paths into the bundle relative to it: the output must not
  // depend on where the script was run from.
  absWorkingDir: here,
  bundle: true,
  format: 'iife',
  // Not the engine's es2017: foliate uses static class blocks / private methods / \p{} regexes.
  // What this costs on old Android WebViews is an open ADR-029 gate.
  target: ['chrome90'],
  write: false,
  minify,
  keepNames: minify,
  legalComments: 'inline',
  // The page stubs the format modules out; a format reader is exactly one of them.
  plugins: entry.endsWith('.mjs') ? [stubFormats] : [],
  // The PDF reader carries pdf.js's layer stylesheets as strings.
  loader: { '.css': 'text' },
  // pdf.js reads import.meta.url only on paths the page never takes (a Worker by URL, Node, wasm decoders).
  logOverride: { 'empty-import-meta': 'silent' },
})).outputFiles[0].text

// The HTML shell, its CSP and nonce placeholder, and the format-reader carrier: carrier.mjs.

const js = await bundle('page.mjs')
const chunks = Object.fromEntries(await Promise.all(Object.entries(FORMATS).map(async ([k, src]) => [k, await bundle(src, MINIFIED.has(k))])))
const page = formatsJs(chunks) + js
const sizes = Object.entries(chunks).map(([k, v]) => `${k} ${v.length}`).join(', ')
const content = `// AUTO-GENERATED — do not edit.
// Source: packages/reader/src/page.mjs (+ store.mjs), built by build.mjs beside it.
// Regenerate: pnpm -C apps/web build:reader
//
// foliate-js fork ${FOLIATE_SHA} (mrviduus/foliate-js, branch textstack-pin:
// upstream 78914aef + our paginator commit d73682a + six #1182 commits, see build.mjs;
// MIT © John Factotum; bundled zip.js BSD-3-Clause; pdf.js Apache-2.0, its cMaps BSD-3-Clause).

/* eslint-disable */
/* prettier-ignore */
const PAGE_HTML = ${JSON.stringify(html(page))}

function fill(page: string, nonce: string): string {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(nonce)) throw new Error('v2 reader page: nonce must be base64 or hex, at least 16 chars')
  // The placeholder fits that rule and is public: a page "filled" with it runs any script carrying it.
  if (nonce.includes(${JSON.stringify(NONCE)})) throw new Error('v2 reader page: the placeholder is not a nonce')
  return page.split(${JSON.stringify(NONCE)}).join(nonce)
}

/** The page with \`nonce\` in its CSP and script tag. A fresh random nonce per load, base64 or hex, >= 16 chars. The web frame's (frame.mjs). */
export function readerPageHtml(nonce: string): string {
  return fill(PAGE_HTML, nonce)
}

/** The Android host's page (#1228): the same, with connect-src naming the two directories its interceptor serves. */
export function readerAndroidPageHtml(nonce: string): string {
  // The CSP meta is the first thing in the head, ahead of the script: its first occurrence is the one replaced.
  // Not kept: a second copy of the page would stay in memory for the life of the app.
  return fill(PAGE_HTML.replace(${JSON.stringify(CSP)}, ${JSON.stringify(ANDROID_CSP)}), nonce)
}
`

if (process.argv.includes('--check')) {
  let failed = false
  if (js.length > BUDGET) {
    console.error(`[check:reader] the page script is ${js.length} chars, over its ${BUDGET} budget (build.mjs BUDGET, ADR-029).`)
    failed = true
  }
  // A reader with no budget fails too: `undefined` would let any size through.
  for (const [k, v] of Object.entries(chunks)) if (!(v.length <= FORMAT_BUDGET[k])) {
    console.error(`[check:reader] the ${k} reader is ${v.length} chars, over its ${FORMAT_BUDGET[k] ?? 'missing'} budget (build.mjs FORMAT_BUDGET).`)
    failed = true
  }
  if ((existsSync(out) ? readFileSync(out, 'utf8') : null) !== content) {
    console.error(`[check:reader] ${out} is out of date. Run: pnpm -C apps/web build:reader`)
    failed = true
  }
  if (failed) process.exit(1)
  console.log(`[check:reader] ${out} is up to date (${js.length} chars; formats: ${sizes}).`)
} else {
  writeFileSync(out, content)
  console.log(`wrote ${out} (${js.length} chars script; formats: ${sizes}; foliate-js ${FOLIATE_SHA.slice(0, 8)})`)
}

if (process.argv.includes('--repro')) {
  const repro = resolve(here, '.vendor/readerPage.repro.html')
  writeFileSync(repro, html(formatsJs(chunks) + await bundle('repro.mjs')).split(NONCE).join(randomBytes(18).toString('base64')))
  console.log(`wrote ${repro} (test only)`)
}
