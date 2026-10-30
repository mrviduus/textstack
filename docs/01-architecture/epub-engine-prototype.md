# Local EPUB engine prototype

**Status: Scoped prototype · 2026-10-29.** Owner approved testing a ready-made EPUB parsing/rendering
core before implementing local import around the current renderer. This is not approval to replace
the production reader or to accept the V2 schema. Implementation is a separate Code Agent task below.

## Goal

Determine whether a library-owned EPUB parser and renderer can replace enough custom infrastructure
to simplify TextStack while preserving translation, annotations, resume and chapter context for MCP.
Start with foliate-js as the candidate, not a commitment. No wholesale application fork.

## Scope

- An isolated development harness, outside production reader routes. One EPUB at a time, no account.
- Open a local EPUB through the candidate's parser **and renderer**, not by extracting HTML into our
  existing renderer. Resolve book CSS, fonts, images and chapter links locally.
- Validate the same core in a desktop browser and the existing Android WebView environment. Browser
  setup may come first for fast feedback; browser success alone does not satisfy the Android gate.
- Use existing translation/annotation concepts through a small adapter. Identify reusable code and
  assumptions tied to the old DOM, scroll positions or chapter representation.
- Use app-managed local bytes and prototype-only storage. No production progress or library writes.

Not included: production import UX, duplicate/replacement implementation, catalog conversion, sync,
MCP authorization/sharing persistence, PDF changes, Dapper work, database migrations or Tauri adoption.
Do not implement a second EPUB parser or a general multi-engine framework for this experiment.

## Behaviors to demonstrate

| Behavior | Evidence required |
|---|---|
| Local reading | Open retained EPUB bytes with the API unavailable; navigate chapters and internal links; load embedded images/CSS/fonts where present. |
| Word interaction | Tap a word and obtain the correct text and coordinates on both clients. Use an actual translation response when available; a recorded translation may isolate layout tests but must be labeled. |
| Inline translation | Show the translation above the selected word using the intended product interaction. Check scrolling, font-size changes and chapter navigation; a detached tooltip alone does not prove compatibility. |
| Highlight | Select a multiword range, save quoted text plus a candidate locator, reopen and display the saved highlight. Report unsupported cases. |
| Resume | Save a candidate location, close/reopen, and restore it after a font-size or viewport change. A raw scroll offset alone is insufficient evidence. |
| MCP context boundary | Extract the chosen chapter's readable text and selected notes with source provenance. Inspect the payload locally; no live MCP/server integration is needed. Do not include later chapters implicitly. |

Use at least two non-sensitive, redistributable EPUB fixtures: one ordinary reflow book and one with
images/styles and internal links. Record fixture provenance. Do not copy a user's private book into
the repo. Fixed-layout, DRM and legacy-location migration are not claimed supported by this experiment.

## Validation and decision

Before coding, record the exact dependency source/revision and verify license obligations for the
selected package and any borrowed source. Pin the candidate; distinguish upstream code from patches.
Do not pull an entire application fork to get its engine. If available APIs require extensive patches,
document that cost instead of hiding it inside the adapter.

Add focused integration checks for adapter outputs (word/range mapping, serialized location and
chapter-context boundaries). Run the relevant existing reader checks for any reused code changed.
Use real browser/WebView checks for selection, layout and resource access; mocked DOM tests alone
cannot establish these behaviors. No coverage target or exhaustive engine test suite for the spike.

Report a pass/partial/fail/not-run matrix by behavior, fixture and client, with exact reproduction
steps. Note startup time and obvious memory problems as observations, not production benchmarks.
If Android/device access is unavailable, report that gate as not run and leave the conclusion provisional.

Recommend one outcome:

1. Proceed to a production local-EPUB PDD using the candidate core.
2. Retain the current renderer and evaluate only a library-based format loader.
3. Reject this candidate, with concrete blocking evidence.

Assess reduction in **owned responsibilities**, not only lines of adapter code. Account for locations,
DOM hooks, resources, security, dependency patches and the future migration of existing annotations.
The prototype need not solve legacy migration; it must expose its incompatibilities.

## Acceptance

- Runnable isolated harness and setup instructions; production reader and PDF routes remain unchanged.
- Exact dependency and fixture provenance documented.
- The six behaviors above have reproducible evidence or explicit failures/not-run labels.
- No production user data, server schema or existing saved positions changed.
- Written recommendation with trade-offs; no automatic decision to replace the production engine.

## Code Agent task

Implement the isolated prototype described in this document. First read the repository instructions,
the current reader API and the translation/annotation integrations. Inspect the candidate's actual APIs
and license, pin its revision, then choose the smallest development harness that exercises both its
EPUB parser and renderer. Keep the production engine intact and avoid unrelated refactors.

Demonstrate local reading, word interaction, inline translations, persisted highlights, durable resume
after layout changes, and selected-chapter context extraction. Validate in a browser and Android's
existing WebView path. Keep every persisted experiment record separate from production records.
Do not call production write APIs or add backend endpoints for this spike.

Deliver the harness, focused checks, exact run instructions and a result matrix. Distinguish real
translation calls from fixtures, automated checks from manual inspection, and tested clients from
unavailable ones. Finish with a recommendation and the minimum next slice. Do not commit, push or
create a PR unless separately authorized.

## Unresolved questions

- Dependency/patch compatibility and license: verify the exact selected revision.
- Android runtime available? Otherwise its gate stays not run.
- Existing positions/highlights compatible? Record evidence; design migration separately.
