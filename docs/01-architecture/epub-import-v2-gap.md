# EPUB import → open → resume: current code versus V2

**Status: Research · 2026-10-29.** Code inspection only; no device, browser, API or database tests run.
The [V2 target model](v2-target-model.md) records owner decisions. This audit does not authorize implementation.

## Main finding

The current entry point is a server upload, not a local EPUB import. The existing reader consumes
extracted chapters. Keeping its reading features does not by itself provide a local EPUB parser or
durable original-file storage on each client. This boundary is the first V2 design task.

Clarification (2026-10-29): local parsing does not mean writing a new EPUB parser. Evaluate an
existing EPUB library first. Compare a format-loader adapter feeding the current renderer with a
replacement parsing/rendering core. Neither choice is accepted yet. Validate translation overlays,
selection/highlights, locators, chapter text for MCP and mobile WebView resource loading before
promising a smaller implementation. Server extraction is not a prerequisite for either local approach.

## Evidence and disposition

| Step | Current code | V2 disposition |
|---|---|---|
| Choose file | Mobile uses DocumentPicker with `copyToCacheDirectory: true`; web uses a file input/drop flow | Reuse interaction where useful. A picker cache copy is not a durable application library. |
| Session | Upload endpoint requires a user id. Mobile SessionGate can create a guest session | Local reading/import must work without creating a server session. A guest server account is not accountless local storage. |
| Import | Both clients POST the file. API stores the original, creates `user_books`, `user_book_files`, `user_ingestion_jobs`, returns Processing | Replace the EPUB prerequisite with local copy + validation/parsing. Cloud upload becomes optional background work. |
| Duplicate detection | Service computes SHA-256 and stores it, but CreateBookAsync creates a new book id; its collision query checks the slug, not the file hash | Add the agreed owner-scoped duplicate behavior. Retain SHA-256 as an available implementation reference, not a newly approved client contract. |
| Metadata | Initial title comes from filename; worker can replace it with extracted metadata and fill author/language | Preserve fallback behavior in the local import contract. No server enrichment dependency for reading. |
| Cover | Worker skips certain cover-decoding errors; absent cover does not block ingestion. Storage failures can still fail the job | Preserve tolerance of absent/unsupported cover. Define local storage failure separately. |
| EPUB preparation | Worker extracts and persists chapter content, then marks Ready; failed extraction marks Failed | Local import must prepare readable content. Choose a local parser/adapter based on preserved engine needs, not an assumed existing EPUB loader. |
| First open | Web EPUB upload polls processing, then shows Ready; opening is a separate action. Mobile returns to the previous screen and starts an offline-library sweep | Implement the agreed single-book auto-open after successful local import. Batch import is not added to the first slice. |
| Offline content | Mobile reader can open cached extracted chapters first. Post-upload sweep is not a guarantee the newly processing book is already downloaded | Reuse relevant reader/cache behavior, but explicitly provide the local file and content adapter. Web storage/persistence needs a separate capability check. |
| Position restoration | Existing local persistence, locator restoration and remote-newer-position decisions are traced separately | Preserve the current reading behavior; adapt book/chapter identities and storage boundaries instead of rebuilding it blindly. |
| Errors | Failed server ingestion leaves a Failed book entry with an error and retry paths | Decide the local import UX explicitly. The proposed “no unusable library entry” policy is not today's behavior and is not yet accepted. |

### Sources inspected

- [Mobile upload](../../apps/mobile/app/my-books/upload.tsx): picker, session gate, POST, return navigation and background sweep.
- [Web upload form](../../apps/web/src/components/library/UploadForm.tsx): file upload and progress.
- [Web upload modal](../../apps/web/src/components/library/UploadModal.tsx): processing polling, Ready/Failed states; PDF opens separately without waiting for extraction.
- [Upload endpoint](../../backend/src/Api/Endpoints/UserBooksEndpoints.cs): `UploadBook` resolves user id before accepting the file.
- [UserBookService](../../backend/src/Application/UserBooks/UserBookService.cs): `UploadAsync`, `CreateBookAsync`, hash, original storage and queued ingestion.
- [Worker ingestion](../../backend/src/Worker/Services/UserIngestionService.cs): extraction, cover handling, chapter persistence, metadata and Ready/Failed states.
- [Mobile chapter source](../../apps/mobile/src/components/reader/useUserBookReaderSource.ts): cached chapter first, server refresh second.
- [Open/resume trace](reader-open-resume.md): existing reader behavior and its evidence limitations.

## First implementation boundary to specify

Updated owner direction (2026-10-29): run the [isolated engine prototype](epub-engine-prototype.md)
before the production import slice below. Compare a ready-made parsing/rendering core with retaining
our renderer. Feeding the existing engine is now a fallback candidate, not a predetermined requirement.

Write a PDD for one local EPUB on one named client before extending it to all clients. It must cover:

1. File selection → application-owned copy → local validation and preparation → library entry → open.
2. Feeding local content, navigation and resource references to the engine selected after the prototype.
3. Reopening offline with the existing locator behavior and without a cloud account.
4. Exact duplicate handling without resetting the existing reader data.
5. Import failure/cancellation cleanup, optional metadata fallbacks and device-storage errors.

Do not include catalog conversion, new sync infrastructure, PDF redesign or another Dapper migration.
No new server table is justified by local import alone. Server metadata registration and file sync need
a separate contract before either is implemented.

## Verification for that future slice

- Import an EPUB offline without a server session; open and reopen it after restarting the app.
- Delete the original picker source; the retained copy must remain readable.
- Re-import identical bytes; no duplicate entry or reset progress/notes.
- Missing cover/title versus malformed content: verify the explicitly chosen outcomes.
- Cancel or interrupt import; retry must not create duplicate entries or leave unusable managed copies.
- Keep existing PDF opening behavior unchanged; run relevant existing reader restoration tests.
- Verify network-disabled operation on the selected real client; code inspection alone is insufficient.

## Open questions

- First client: Android or web?
- Invalid EPUB: error only, or a visible failed entry with retry?
- Local EPUB parser/adapter: what engine features and resource behavior must it preserve?
