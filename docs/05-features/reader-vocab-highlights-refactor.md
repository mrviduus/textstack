# Reader Vocab Highlights — Refactor Design

> **Historical — superseded.** The fix shipped as the overlay-v2 engine (`packages/reader-overlay`, `VocabOverlayLayer` / `VocabTranslationOverlay` / `HighlightOverlayLayer`), not the CSS Custom Highlight API, and the web reader became one chapter per document (`ReaderSection`), which removed the eviction bug's cause. Cleanup record: [reader-overlay-v2-slice-10.md](../reader-overlay-v2-slice-10.md).

Move vocabulary word underlining + inline translations from imperative DOM
mutation (`<mark data-vocab-mark>` wrappers) to **CSS Custom Highlight API**
with a React-managed translation overlay.

**Status**: In progress (branch `refactor/reader-vocab-highlights`)
**Author**: Vasyl Vdovychenko + Claude
**Started**: 2026-04-22

## Why

### Bug (user-facing)

Словарные подчёркивания и inline-переводы (superscript над словом) **исчезают
при скролле**. Повторно появляются только при событиях, меняющих effect deps
(open/close popup, toggle settings). Для core-фичи ("vocabulary-через-чтение")
это неприемлемо.

### Root cause (code-level)

1. `useScrollReader` эвиктит главы вне окна `CHAPTERS_EVICT_WINDOW=3`; при
   возврате глава reload через `fetchChapter` → `ReaderContent.tsx:294`
   применяет `dangerouslySetInnerHTML` → React полностью перезаписывает
   innerHTML → все вставленные `<mark>` элементы стираются.
2. `VocabWordLayer.tsx` использует `useEffect` deps
   `[containerRef, vocabMap, showInlineTranslations, activeBubble?.*]`.
   Ни одна из них не меняется при remount → `markWords` не перезапускается.
3. Эталонный `HighlightLayer` решает эту же проблему **MutationObserver**'ом.
   VocabWordLayer просто не имел этой защиты.

### Architectural issues beyond the bug

- Imperative DOM mutation плохо сочетается с React reconciliation
- Нет unit / E2E тестов вообще
- Web и mobile импл-ции независимо эволюционируют (web: React effect, mobile:
  injected JS в WebView) — риск расхождения
- Forced layouts на каждом remount (walk text nodes + wrap)
- Inline translation span позиционируется через CSS `position: absolute`
  внутри `<mark>` — конфликтует с selection (`extractWordFromRange`
  специально фильтрует этот span — признак напряжения в модели)

## What we're building

### High-level architecture

```
ReaderHighlights
  └── VocabHighlightErrorBoundary  ──── throws → renders legacy VocabWordLayer
        └── VocabHighlightLayer (React)
              ├── vocabHighlightEngine  ──── pure: TreeWalker → Map<stage, Range[]>
              ├── customHighlightRegistry ── wraps CSS.highlights
              │   │                          new Highlight(...ranges)
              │   │                          CSS draws underline via
              │   │                          ::highlight(vocab-<stage>)
              │   └── [feature-detect fallback] → legacy
              ├── useContainerMutationObserver ── RAF-debounced re-compute on DOM change
              └── VocabTranslationOverlay ── React overlay of absolute <span>s
                    ├── IntersectionObserver (только видимые слова)
                    ├── ResizeObserver (font/container reflow)
                    └── scroll throttle
```

### Key decisions (ADR-style)

| # | Decision | Rationale | Alternative rejected |
|---|----------|-----------|----------------------|
| 1 | **CSS Custom Highlight API** для underline | Zero DOM mutation, native render, remount-safe | imperative `<mark>` (current), styled `<span>` layer |
| 2 | **React overlay** для inline translations | API не позволяет добавлять child-элементы в highlight; абсолютное позиционирование через React — декларативно | Highlight `::before` (не поддерживается), mutation of DOM (возвращает нас к bug) |
| 3 | **IntersectionObserver** для overlay rendering | O(visible) вместо O(total) — можно иметь 5000 vocab words в книге без просадки | Render all at once |
| 4 | **MutationObserver** как защита | Проверенный паттерн в этом коде (HighlightLayer) | Прокидывать `chaptersKey` вручную (fragile) |
| 5 | **ErrorBoundary + feature flag + killswitch + legacy fallback** | Core-фича; любой failure → мгновенный silent fallback; юзер не замечает | Ship и молиться |
| 6 | **Oracle shadow-mode** тест на staging | Прямое runtime-сравнение с legacy для поиска silent-divergence'ов | Только unit + E2E (не ловят edge-cases в реальном прод-контенте) |

### Browser support (checked 2026-04-22)

| Browser | Support |
|---------|---------|
| Chrome 105+ (Aug 2022) | ✅ |
| Safari 17.2+ (Dec 2023) | ✅ |
| Firefox 140+ (2025) | ✅ |
| iOS Safari 17.2+ | ✅ |
| Android WebView current | ✅ |

Global coverage ≈96%. Remaining 4% получают legacy `VocabWordLayer` через
feature-detection fallback — функционально эквивалентно текущему поведению.

## File plan

### New modules (web)

| Path | Role |
|------|------|
| `apps/web/src/lib/vocabHighlightEngine.ts` | Pure. Вход — container + vocabMap + activeBubble. Выход — `Map<stageName, Range[]>`. Без DOM-мутаций. Переиспользует `tokenizeVocabWords`, `normalizeVocabKey` из `lib/vocabKey.ts`. |
| `apps/web/src/lib/customHighlightRegistry.ts` | Singleton. `isSupported()`, `register(name, ranges)`, `clear(name)`, `clearAll()`. Feature-detects `CSS.highlights`. |
| `apps/web/src/lib/vocabHighlightTelemetry.ts` | Counter API: `count(event)`, `reportIfNeeded()`. Console + buffered flush через существующий analytics. |
| `apps/web/src/hooks/useContainerMutationObserver.ts` | Generic. Принимает ref + callback. RAF-debounced. Observes `childList + subtree + characterData`. |
| `apps/web/src/components/reader/VocabHighlightLayer.tsx` | React orchestrator. Computes matches → registers → renders overlay. |
| `apps/web/src/components/reader/VocabTranslationOverlay.tsx` | Абсолютно-позиционированные `<span>` поверх видимых слов с переводами. |
| `apps/web/src/components/reader/VocabHighlightErrorBoundary.tsx` | React ErrorBoundary с legacy fallback render. |
| `apps/web/src/styles/vocab-highlights.css` | `::highlight(vocab-new/learning/mastered)`, overlay styles. |

### Tests (web)

| Path | Coverage |
|------|----------|
| `apps/web/src/lib/__tests__/vocabHighlightEngine.test.ts` | Tokenization, Range boundaries, activeBubble merge, node filter |
| `apps/web/src/lib/__tests__/customHighlightRegistry.test.ts` | Feature detect, register/clear, mock `CSS.highlights` |
| `apps/web/src/lib/__tests__/vocabHighlightTelemetry.test.ts` | Counter semantics |
| `apps/web/src/hooks/__tests__/useContainerMutationObserver.test.tsx` | Fires on mutation, debounce, cleanup |
| `apps/web/src/components/reader/__tests__/VocabHighlightLayer.test.tsx` | Mount, vocabMap changes, remount recovery, unmount |
| `apps/web/e2e/tests/reader-vocab-highlights.spec.ts` | Scroll-past-eviction persistence + edge cases |

### Modified (web)

| Path | Change |
|------|--------|
| `apps/web/src/components/reader/ReaderHighlights.tsx` | Swap `VocabWordLayer` → `VocabHighlightLayer` behind flag + ErrorBoundary |
| `apps/web/src/components/reader/VocabWordLayer.tsx` | `@deprecated`, stays as fallback path (removed in Slice 10) |
| `apps/web/src/styles/reader.css` | Translation span rules migrate to `vocab-highlights.css` |
| `apps/web/.env.example` | Adds `VITE_READER_CUSTOM_HIGHLIGHTS`, `VITE_READER_HIGHLIGHTS_ORACLE` |

### Mobile parity

| Path | Change |
|------|--------|
| `apps/mobile/src/lib/readerHtml.ts` | `markVocabWords` / `removeVocabMarks` → `applyVocabHighlights` / `clearVocabHighlights` via injected CSS Custom Highlight API (WebView-safe since iOS 17.2+ / modern Android) |
| `apps/mobile/src/lib/__tests__/vocabHighlightParity.test.ts` | Snapshot test: given same input, web engine and mobile injected JS produce identical stage→ranges mapping |
| `apps/mobile/e2e/tests/reader-vocab-highlights.spec.ts` | E2E parity suite |

## Reliability engineering

### Defense-in-depth layers

1. **Build-time env flag** `VITE_READER_CUSTOM_HIGHLIGHTS` — default off until
   Slice 9 in prod
2. **Runtime killswitch** `window.__textstackDisableCustomHighlights` — support
   can flip in user's console; drives runtime path choice without rebuild
3. **Feature detection** — `'highlights' in CSS && typeof Highlight === 'function'`;
   false → legacy + telemetry
4. **ErrorBoundary** — any React-layer throw → legacy + telemetry
5. **Runtime invariants** (DEV only) — assert registered range count matches
   computed count, assert cleanup on unmount
6. **Legacy path preserved** — not removed until 4 weeks of clean prod metrics
   (Slice 10)

### Oracle shadow-mode

When `VITE_READER_HIGHLIGHTS_ORACLE=true` (staging default):

1. Legacy renders visibly (ground truth)
2. New path computes ranges into a **separate Highlight name** (`vocab-oracle-*`)
   styled invisibly
3. Every N mutations + on scroll-idle → compare: set of words in legacy `<mark>`
   DOM vs set of words in new registry
4. Any divergence → `console.error` with diff + `vocabhl.oracle.diff` telemetry

Soak 1 week staging. Zero divergences is the gate.

### Telemetry events

Logged with prefix `[VocabHighlight]`:

| Event | Meaning |
|-------|---------|
| `boot.supported` | Feature detect passed, new path active |
| `boot.fallback` | Fallback activated (reason: `unsupported`, `env-flag`, `killswitch`, `error`) |
| `register.success` | Ranges registered correctly |
| `register.mismatch` | Registered count ≠ expected |
| `mutation.recover` | MutationObserver re-registered after DOM change |
| `overlay.reflow` | Overlay recomputed after resize / font change |
| `error.*` | Exception caught (stage, message) |
| `oracle.diff` | Legacy vs new set diff (staging only) |

### Rollback triggers

Immediate rollback (flip env flag → redeploy) if any of:
- `fallback_rate > 2%`
- `register.mismatch rate > 0.1%`
- `oracle.diff_rate > 0%` (during oracle phase)
- >5 `error.*` in 24h
- Confirmed user-reported visual regression

## Rollout timeline

| Week | Phase | Gate |
|------|-------|------|
| 1–2 | Slices 1–3 local dev, unit tests green | 100% branch coverage |
| 3 | Slice 4–5: flag + E2E on web; staging deploy | 10 consecutive green E2E runs |
| 4 | Slice 6: mobile port; oracle soak on staging | 0 oracle divergences in 7 days |
| 5 | Slice 8 canary: flag on for 1 test user in prod | 7 days, 0 errors |
| 6 | Slice 9: flag on globally + killswitch visible in admin UI | — |
| 7–8 | Soak with active monitoring | 4 weeks clean metrics |
| 9+ | Slice 10: delete legacy, env flag, oracle code | — |

No time pressure on any phase. If any gate fails, stop and investigate.

## Acceptance checklist (zero-tolerance)

- [ ] 100% unit branch coverage: engine, registry, telemetry, hook, component
- [ ] E2E green 10 consecutive runs (flake-test)
- [ ] Oracle prod-like workload: 1h scroll through ≥100 chapters w/ ≥500 vocab
      words — 0 divergences
- [ ] Visual regression <1% pixel diff on test book
- [ ] Real-device: iOS Safari 17.2+, Android Chrome latest — PASS
- [ ] Fallback path: force `isSupported=false` → UX identical to legacy
- [ ] ErrorBoundary: force throw → UX identical to legacy
- [ ] Killswitch: set `window.__textstackDisableCustomHighlights=true` → legacy
- [ ] Benchmark: new path ≥ legacy perf in every scenario (strict ≥)
- [ ] Mobile parity: iOS + Android WebView visual output matches web

## Performance targets

| Metric | Current | Target |
|--------|---------|--------|
| Initial render (300 words, 1 chapter) | ~40ms | <15ms |
| Remount recovery | **broken** | <20ms |
| Scroll FPS (500 vocab words over 10 chapters) | 45–55 w/ drops | 60 sustained |
| Overlay DOM size | O(total) | O(visible) |
| Forced layouts per scroll tick | per-remount thrash | 0 |

Benchmark: `apps/web/scripts/bench-vocab-highlights.mjs` — Playwright +
Performance API.

## FAQ

**Q: Почему не ограничиться MutationObserver в VocabWordLayer (минимальный фикс)?**
Сам пользователь выбрал глубокий рефакторинг как единственный способ гарантировать
core-фичу надолго. Минимальный фикс устраняет симптом, но оставляет imperative
DOM-мутацию, forced layouts, расхождение с mobile и отсутствие тестов.

**Q: Why not merge all overlay systems (highlights + TTS + vocab)?**
Scope creep. Три независимых слоя сейчас работают; объединять их здесь
нецелесообразно. Возможная будущая работа.

**Q: What happens on Safari 16 (no Custom Highlight API)?**
Feature-detect returns false → legacy `VocabWordLayer` path activates
transparently. Telemetry logs `boot.fallback:unsupported`.

**Q: How are iOS WebView builds covered?**
Mobile app targets iOS 16+; on iOS 16 WebView falls back. iOS 17.2+ users
(majority by rollout time) use new path. Parity validated via snapshot test
against same engine logic.

**Q: Translation overlay over word — stacking / scroll / resize performance?**
`getBoundingClientRect` per visible word only (IntersectionObserver gate).
Recompute throttled (RAF) on scroll; debounced (100ms) on font/size change.
Overlay uses `transform: translate()` for GPU-accelerated positioning.

## References

- Plan file: `/Users/vasylvdovychenko/.claude/plans/imperative-stirring-summit.md` (session-local, ephemeral)
- Bug report thread: (in-session, 2026-04-22)
- CSS Custom Highlight API spec: https://www.w3.org/TR/css-highlight-api-1/
- Current code: `VocabWordLayer.tsx`, `HighlightLayer.tsx` (MutationObserver reference)
