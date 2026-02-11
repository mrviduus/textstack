# TODO: Upcoming Features

## Feature 1: LLM Batch Processing for Drafts

**Goal**: Automate SEO/description generation for ~1000 draft books

### Tech Stack
- **LLM**: Ollama (self-hosted)
- **Scheduler**: Background job system (Worker service extension or new MCP scheduler)

### Flow
1. Admin selects batch of drafts (10-20 books)
2. Scheduler queues LLM tasks
3. For each book:
   - Generate `seo_description` from existing content
   - Reformat `description`
4. Set status to `ready_for_review`
5. Admin reviews and publishes

### Data Model
- Use existing `Edition.description` and `Edition.seo_description` fields
- Add `Edition.status` enum: `draft` | `ready_for_review` | `published`
- Store original description for rollback (new field or separate table?)

### Admin UI
- Batch selection UI
- "Generate SEO" button for batch
- "Reset to Default" button per book (clears SEO, keeps description)
- Review queue view

### Open Questions (TBD)
1. **Ollama model?** - llama3, mistral, qwen, phi? Need to test quality vs speed tradeoff
2. **Prompt templates storage?** - Options: DB (editable at runtime), config file (version controlled), hardcoded (simplest). Decision depends on how often prompts need tuning
3. **Rate limiting?** - How many ms/sec between LLM calls? Depends on Ollama performance on server hardware
4. **Error handling?** - Retry count? Exponential backoff? Mark as failed and skip?
5. **Rollback storage?** - New `Edition.original_description` field or separate `edition_history` table?

---

## Feature 2: Eye/Head Tracking Scroll for Reader

**Goal**: Hands-free reading - scroll by looking down/up

### Tech Stack (from prototype `/Users/vasylvdovychenko/projects/onlineLib/test/`)
- **MediaPipe FaceLandmarker** (`@mediapipe/tasks-vision@0.10.3` from CDN)
- **WebRTC** for camera access
- **GPU delegate** for performance

### Algorithm
- Head pitch detection (nose tip vs forehead/chin midpoint)
- Iris vertical position in eye socket
- Combined: 60% head + 40% iris
- Hysteresis: 200ms delay before intent change
- Face timeout: 400ms without detection = stop

### Scroll Zones
- Look down (gaze > 52%) = scroll down
- Look center/up = stop
- Speed presets: slow (100px/s), normal (180px/s), fast (280px/s)

### Integration Points
- Reader component: `apps/web-next/app/[lang]/books/[slug]/`
- New toggle in reader settings
- Camera permission handling

### Open Questions (TBD)
1. **Mobile support?** - Front camera quality varies. iOS Safari has WebRTC quirks. Worth supporting or desktop-only initially?
2. **Battery/performance impact?** - MediaPipe GPU delegate is efficient but continuous camera + ML = drain. Need testing on real devices
3. **Privacy notice?** - Camera permission requires user consent. Need clear UI explaining why + that video never leaves device
4. **Calibration?** - Auto-calibrate on first frames (current approach) or manual "look at center" calibration step?
5. **Accessibility?** - Is this feature itself an accessibility aid? How to handle users who can't use head/eye tracking?
6. **Bundle size?** - MediaPipe from CDN or bundle locally? CDN = faster initial load but external dependency

---

---

## SEO Follow-ups

### Production Setup
- [ ] Fill verification codes in `apps/web/index.html` (Google + Bing)
- [ ] Submit sitemap to Google Search Console and Bing Webmaster Tools

### Content Management
- [x] Add author bios and photos via Admin UI
- [x] Create genres via Admin UI
- [x] Admin endpoints for Authors/Genres CRUD

### Future SEO Slices
- [ ] Slice 2: Admin SEO Control (editable slug, SEO preview, bulk indexable toggle)
- [ ] Slice 3: Slug Change Redirects (redirect table, auto-301)
- [ ] Slice 4: Structured Data validation (JSON-LD schema)

### Technical Debt
- [ ] Author slug transliteration (Cyrillic → Latin)
- [ ] Replace `authorsJson` with proper Author objects in API

---

## Search Library Follow-ups

### Backend
- [ ] Re-indexing endpoint for admin API
- [ ] Bulk re-index CLI command
- [ ] Search analytics/tracking (query logging)
- [ ] Faceted search (filter by author, language, year)
- [ ] Search result caching

### Frontend
- [ ] Loading skeleton for suggestions dropdown
- [ ] Client-side suggestions caching
- [x] "View all results" link
- [ ] Keyboard shortcut (Cmd/Ctrl+K)
- [x] Mobile search UI

### Future Providers
- [ ] Elasticsearch provider
- [ ] Vector/semantic search provider
- [ ] Algolia provider (hosted)

### Testing
- [x] Integration tests for search endpoints
- [x] E2E tests for search UI
- [ ] Performance benchmarks

---

## Priority
1. **LLM Batch** - higher priority (immediate need for 1000 drafts)
2. **Search improvements** - incremental
3. **Eye Tracking** - experimental/research phase
