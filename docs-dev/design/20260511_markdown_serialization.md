# Markdown Serialization in the Web App

Date: 2026-05-11

Builds on:

- `docs-dev/design/20260403_drive_agentic_search.md`
- `docs-dev/design/20260409_track_drive_versions.md`

## Summary

Move notebook-to-Markdown serialization into the web app.

Do not depend on `runme.parser.v1.ParserService.Serialize`, because the web app
no longer has a backend that can reliably provide it.

Keep Markdown sidecar files for now.

Decision:

1. Implement a deterministic TypeScript serializer for Runme notebooks.
2. Continue syncing `<basename>.index.md` sidecars for Drive-backed notebooks.
3. Treat sidecars as the primary search artifact for Google Drive full-text
   search.
4. Consider adding Drive `contentHints.indexableText` later as a supplemental
   optimization, not as the only indexing mechanism.

## Problem

Today the local notebook mirror still tries to serialize notebooks to Markdown
by calling the parser service:

- `LocalNotebooks.save(...)` persists notebook JSON locally, then enqueues
  Markdown sync.
- `LocalNotebooks.syncMarkdownFile(...)` creates or updates
  `<basename>.index.md` next to the Drive-backed notebook.
- That method currently calls `runmeClientManager.get().serializeNotebook(...)`,
  which is just a thin RPC wrapper around `ParserService.Serialize`.

That path fails when no backend implements the parser service.

At the same time, the sidecar file is still useful product behavior because it
gives Google Drive a text-shaped artifact to search and gives agents or users a
human-readable representation of notebook content.

## Questions We Need to Answer

### 1) Does Google Drive support full-text search over JSON files?

Not conclusively from the public docs.

What Google does document:

- Drive searches include file titles and content.
- Drive API `fullText contains '...'` matches against `name`, `description`,
  `indexableText`, or text in the file's content or metadata.

That strongly suggests uploaded JSON blob content may be indexed as text.

However, Google does not explicitly document a notebook-JSON-specific or
`application/json`-specific full-text indexing guarantee, and the preview/help
docs list common previewable text/code types without naming JSON.

So the right conclusion is:

- We should not claim that Drive categorically cannot search JSON files.
- We also should not rely on raw notebook JSON being a good search target.

### 2) Do we still need auxiliary Markdown files?

Probably yes, for now.

Even if Drive indexes JSON blobs, raw notebook JSON is a poor search corpus:

- It contains structural noise (`cells`, metadata keys, protobuf-shaped fields).
- It interleaves content with machine-oriented schema.
- It is much less readable when opened from Drive search results.
- Query matches may rank poorly because important notebook text is diluted by
  repeated field names and serialized structure.

Markdown sidecars solve those problems by presenting notebook content as
natural text and code blocks instead of storage JSON.

## Google Drive Findings

As of 2026-05-11, the relevant Google documentation says:

- The Drive help docs say search includes "titles and content of all files you
  have permission to access."
- The Drive API search reference says `fullText` matches against `name`,
  `description`, `indexableText`, or text in file content/metadata.
- The Drive file resource defines `contentHints.indexableText` as text indexed
  to improve `fullText` queries, with a 128 KB limit.

Sources:

- <https://support.google.com/drive/answer/2375114?hl=en>
- <https://developers.google.com/workspace/drive/api/guides/ref-search-terms>
- <https://developers.google.com/workspace/drive/api/reference/rest/v3/files>

These sources support two design conclusions:

1. Full-text search is a real Drive capability we should design around.
2. `contentHints.indexableText` is a viable alternative or supplement, but its
   128 KB cap makes it insufficient as the only representation for large
   notebooks.

## Goals

- Remove the web app's dependency on backend Markdown serialization.
- Preserve the existing Drive sidecar behavior for search.
- Keep the serializer deterministic so repeated saves produce stable Markdown.
- Preserve current product intent that notebook outputs can be searchable.
- Keep the implementation entirely browser-side.

## Decision

We are choosing Option C.

Implement notebook Markdown serialization in the web app and keep the existing
Drive Markdown sidecar model.

Do not rely on the old backend parser service.

Do not assume Google Drive cannot search JSON at all, but also do not treat raw
JSON as a sufficient notebook search format.

For efficient and readable notebook search, auxiliary Markdown files remain the
default design.

## Non-Goals

- Reproducing the old backend serializer byte-for-byte.
- Reworking notebook JSON persistence.
- Replacing the existing local-mirror / Drive sync architecture.
- Designing a general Markdown parser/importer in this document.
- Solving semantic search or vector retrieval.

## Current Implementation Context

Current behavior in `LocalNotebooks.syncMarkdownFile(...)`:

1. Only Drive-backed files are eligible.
2. If no sidecar exists, create `<basename>.index.md` in the same Drive folder.
3. Deserialize the locally stored notebook JSON.
4. Call backend `Serialize` with outputs enabled and summary disabled.
5. Upload the resulting Markdown as `text/markdown`.

This is already a best-effort sidecar sync, debounced by 20 seconds after save.

The architectural issue is narrow:

- local notebook persistence is already TypeScript-only,
- Drive upload is already browser-only,
- only the notebook-to-Markdown conversion is still backend-dependent.

## Chosen Approach

Render notebook content to Markdown in the browser, then keep uploading
`<basename>.index.md`.

Reasons:

- Removes the backend dependency immediately.
- Preserves the current Drive search strategy.
- Keeps a readable artifact in Drive.
- Avoids the `indexableText` size ceiling.
- Aligns with the existing agentic-search design that searches Markdown
  sidecars and resolves them back to notebooks.

Implement this now.

Optionally add part of Option B later:

- After generating Markdown, also write a truncated plain-text or Markdown
  projection into `contentHints.indexableText` on the canonical JSON file.
- Keep the sidecar as the authoritative search/read artifact.

This gives us three useful properties:

1. no backend dependency,
2. readable searchable sidecar documents,
3. a possible future direct-hit path on the JSON file itself.

## Proposed Design

### 1) Add a browser-side serializer

Add a new module, for example:

- `app/src/lib/markdown/serializeNotebookToMarkdown.ts`

The serializer should operate on `parser_pb.Notebook` and return a UTF-8 string.

The output contract should optimize for readability and search, not for exact
parity with the removed backend implementation.

### 2) Serialization rules

Recommended first-pass rules:

- Notebook-level frontmatter is not required.
- Markdown cells:
  - emit cell text directly with minimal normalization.
- Code cells:
  - emit fenced code blocks using the cell language when known.
  - default to an untyped fence when language is missing.
- Textual outputs:
  - preserve current intent by including outputs in the sidecar.
  - render as fenced blocks after the source cell.
- Non-text/binary outputs:
  - omit payload bytes.
  - optionally include a short placeholder such as "binary output omitted".
- Cell boundaries:
  - separate cells with a stable blank-line convention.

Important:

- We do not need exact reproduction of old parser Markdown.
- We do need deterministic and human-readable output.

### 3) Keep the existing sidecar sync flow

`LocalNotebooks.syncMarkdownFile(...)` should continue to:

1. resolve or create `markdownUri`,
2. serialize from the locally persisted notebook JSON,
3. upload the Markdown sidecar with MIME type `text/markdown`.

The only architectural change is replacing the RPC call with the local
serializer.

### 4) Preserve naming for compatibility

Keep the current sidecar naming convention:

- `<basename>.index.md`

Reasons:

- Existing design docs already assume it.
- Existing records may already store `markdownUri`.
- Search helpers can continue filtering by name and MIME type.

### 5) Defer `appProperties` linkage unless we need stronger resolution

Today sidecars are linked to notebooks implicitly by:

- same parent folder
- sibling naming convention

That is acceptable for this change.

If ambiguity becomes a real issue, add Drive `appProperties` later, for example:

- sidecar stores the canonical notebook file ID
- canonical notebook stores the sidecar file ID

That is useful, but not required to remove backend serialization.

## Alternatives Considered

## Option A: Search raw JSON notebooks only

Do not keep sidecars. Do not set `indexableText`. Rely on Drive indexing the
JSON file itself.

Rejected.

Reasons:

- The docs do not guarantee good ranking or extraction behavior for notebook
  JSON.
- Search results would open a machine-oriented JSON blob, not a readable
  notebook projection.
- This is the weakest path for both user experience and agentic search quality.

## Option B: Stop creating sidecars and write `contentHints.indexableText`

Render notebook text locally, then attach that text to the canonical JSON Drive
file via `contentHints.indexableText`.

Advantages:

- No duplicate Drive files.
- Search results point directly at the canonical notebook file.
- Explicitly uses a Drive feature intended to improve `fullText` queries.

Disadvantages:

- `indexableText` is capped at 128 KB.
- Our current Drive client abstraction does not expose `contentHints`.
- The indexed text is metadata, not a human-readable artifact users can open.
- We would lose the sidecar-based workflow already assumed by the Drive
  agentic-search design.

Conclusion:

Worth evaluating later as a supplemental optimization, but too limiting to be
the only solution today.

## Implementation Plan

### Phase 1: local serializer

1. Add the serializer module and tests.
2. Replace the parser RPC call in `LocalNotebooks.syncMarkdownFile(...)`.
3. Keep the existing debounce, create-if-missing, and Drive upload logic.

### Phase 2: validation and parity checks

1. Test notebooks containing:
   - markdown cells
   - code cells in several languages
   - stdout/stderr text output
   - rich/binary outputs
2. Verify sidecars remain readable in Drive.
3. Verify Drive search returns sidecars for notebook content terms.

### Phase 3: optional Drive metadata enhancement

If we want direct canonical-file matches in Drive search:

1. Extend the Drive client abstraction to support `contentHints.indexableText`.
2. Write a truncated projection of notebook Markdown to the canonical JSON file.
3. Keep sidecars in place unless we prove the metadata-only approach is enough.

## Drive Client Follow-Up for `indexableText`

If we pursue the optional enhancement, current abstractions need expansion.

Today `DriveDoc` only carries:

- `name`
- `mimeType`
- `parents`
- `content`

It does not carry `contentHints`, so neither the fetch-based nor gapi-based
Drive client can write `indexableText`.

That should be a separate follow-up from local Markdown serialization, because
it is not required to unblock removal of the backend dependency.

## Migration and Rollout

- Existing notebooks with `markdownUri` keep using the same sidecar file.
- Existing notebooks without a sidecar continue current behavior and create one
  on the next eligible sync.
- No data migration is required for local notebook JSON.
- No server rollout is required.

## Test Plan

- Unit tests for the serializer covering mixed notebook content.
- Local storage tests proving `syncMarkdownFile(...)` no longer calls the parser
  client.
- Drive sync tests verifying the uploaded MIME type remains `text/markdown`.
- Manual verification:
  - save a Drive-backed notebook,
  - confirm `<basename>.index.md` is updated,
  - search in Drive for notebook text and confirm the sidecar is returned.

## Risks

Risk: local serializer output differs from old backend output.

Mitigation:

- treat readability and determinism as the contract,
- do not require byte-for-byte parity.

Risk: large notebooks generate very large sidecars.

Mitigation:

- acceptable for v1,
- optional future truncation or summarization policy can be added if needed.

Risk: sidecar linkage remains naming-based.

Mitigation:

- preserve current behavior for now,
- add `appProperties` only if ambiguity appears in practice.

Risk: duplicated Drive artifacts may annoy users.

Mitigation:

- this already exists today,
- the sidecar has clear product value for search,
- revisit after evaluating `indexableText`.
