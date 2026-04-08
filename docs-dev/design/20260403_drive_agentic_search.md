# 20260403 Drive Agentic Search

## Status

Draft proposal.

## Problem

The Runme agent should be able to search notebooks stored in Google Drive and
open the relevant documents for read-only inspection, regardless of whether the
active harness is Codex app-server or the browser-direct Responses API path.

Today Drive-backed notebooks are stored as JSON notebook files, and the local
notebook mirror best-effort syncs a Markdown sidecar (`<basename>.index.md`) to
Drive. Those sidecars are much better search targets than raw JSON notebooks
because Drive can index their full text directly.

We want an agent-facing Drive interface that:

- exposes Google Drive's native query syntax instead of hiding it behind a
  custom keyword search DSL,
- lets the agent open and read documents returned by search,
- uses Markdown sidecars to make notebook contents searchable,
- does not expose any write, copy, rename, share, or delete capability.

## Goals

- Add a read-only Drive search/open interface suitable for Runme agent flows in
  both harnesses (`codex` and `responses-direct`).
- Preserve Drive's native query expressiveness (`q`, corpora, shared-drive
  options, ordering, pagination).
- Make notebook full-text search work well by querying Markdown sidecars.
- Return stable, ID-backed Drive URIs so follow-up opens are unambiguous.
- Keep authorization and access control identical to what the user already has
  in Drive.

## Non-Goals

- No Drive mutation APIs in the agent surface.
- No semantic/vector retrieval system in v0.
- No attempt to bypass Drive ACLs or search only within unshared content.
- No broad redesign of the existing notebook storage model in this document.

## Existing Implementation Context

The web app already has three useful building blocks:

- `DriveNotebookStore` can `load`, `list`, and `getMetadata` Drive items by
  stable Drive IDs/URLs.
- `LocalNotebooks.syncMarkdownFile()` writes a Markdown sidecar next to each
  Drive-backed notebook and names it `<basename>.index.md`.
- Existing Drive design notes already prefer stable ID-backed URIs over
  path-like names because duplicate folder/file names are ambiguous.

Current sidecar behavior has one important limitation for search: the Markdown
sidecar is stored as a separate Drive file, but there is no explicit Drive
metadata link from the sidecar back to the canonical notebook JSON file. In v0
we can infer that relation from same-folder sibling naming conventions, but a
better v1 design is to store stable linkage metadata in Drive `appProperties`.

## Prior Art

I inspected a local read-only Google Drive connector implementation and found
three ideas worth carrying over:

- A small tool surface is enough: `search` plus `fetch/open` covers most agent
  workflows.
- Read-only enforcement is done at the API registry layer by exposing only
  read tools and leaving share/copy operations disabled.
- Search results should include both metadata and an opaque document URL/ID that
  can be passed to `open` without making the model reconstruct identifiers.

That prior implementation is less suitable for this repo in two ways:

- It hides native Drive query syntax behind a lexical search box, which makes
  it hard for the agent to use Drive's full `q` language.
- It is not notebook-sidecar-aware, so it cannot preferentially search Markdown
  sidecars and then resolve back to the corresponding notebook.

## Google Drive Query Semantics We Should Preserve

The Drive API's `files.list` endpoint accepts a `q` string with the grammar
`query_term operator value`, and supports operators like `contains`, `=`,
`!=`, `<`, `<=`, `>`, `>=`, `in`, `and`, `or`, and `not`. Search can combine
metadata constraints (`name`, `mimeType`, `modifiedTime`, parent IDs, labels,
etc.) with full-text constraints via `fullText contains '...'`. It also supports
pagination, ordering, field masks, and shared-drive-specific options.

References:

- [Search for files and folders](https://developers.google.com/workspace/drive/api/guides/search-files)
- [Search query terms and operators](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)

## Proposed Agent Interface

Expose a read-only `drive` namespace to AppKernel / code mode with two
functions:

```ts
type DriveQueryRequest = {
  q: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  corpora?: "user" | "drive" | "domain" | "allDrives";
  driveId?: string;
  includeItemsFromAllDrives?: boolean;
  supportsAllDrives?: boolean;
  spaces?: string;
};

type DriveQueryMatch = {
  uri: string;
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  parents: string[];
  webViewLink?: string;
};

type DriveQueryResponse = {
  matches: DriveQueryMatch[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
};

type DriveOpenRequest = {
  uri: string;
  format?: "text" | "notebookJson" | "metadata";
  maxBytes?: number;
};

type DriveOpenResponse = {
  uri: string;
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime?: string;
  webViewLink?: string;
  text?: string;
  truncated?: boolean;
};

interface DriveAgentApi {
  query(request: DriveQueryRequest): Promise<DriveQueryResponse>;
  open(request: DriveOpenRequest): Promise<DriveOpenResponse>;
}
```

### `drive.query`

`drive.query` should pass the caller's `q` expression directly to Drive
`files.list` after applying only safety guardrails that do not reduce query
expressiveness.

Recommended behavior:

- Always use a fixed response field mask that returns only read-only metadata
  needed by `open` and UI/debugging.
- Cap `pageSize` to a safe maximum (for example 100).
- Default `supportsAllDrives=true` and `includeItemsFromAllDrives=true` so
  shared-drive notebooks are discoverable.
- Preserve caller-supplied `corpora`, `driveId`, `spaces`, and `orderBy`.
- Return stable canonical Drive URIs built from file IDs, not path-like names.

### Query builder helpers

Instead of a `mode` argument, query shaping should happen before calling
`drive.query(...)` using composable helpers that return native Drive `q`
strings.

This keeps `drive.query` itself aligned with Drive's API while still making
common query patterns easy to express and chain.

Example helper API:

```ts
const q = drive.q
  .raw("fullText contains 'SLO burn rate'")
  .and("modifiedTime >= '2026-01-01T00:00:00'")
  .restrictToMarkdownSidecars()
  .build();

const result = await drive.query({
  q,
  orderBy: "modifiedTime desc",
  pageSize: 20,
});
```

Equivalent functional style:

```ts
const result = await drive.query({
  q: drive.q.restrictToMarkdownSidecars(
    "fullText contains 'SLO burn rate' and modifiedTime >= '2026-01-01T00:00:00'",
  ),
  orderBy: "modifiedTime desc",
  pageSize: 20,
});
```

Recommended helper surface:

```ts
interface DriveQueryBuilder {
  raw(clause: string): DriveQueryBuilder;
  and(clause: string): DriveQueryBuilder;
  or(clause: string): DriveQueryBuilder;
  not(clause: string): DriveQueryBuilder;
  inParents(folderId: string): DriveQueryBuilder;
  nameContains(value: string): DriveQueryBuilder;
  mimeTypeEquals(value: string): DriveQueryBuilder;
  fullTextContains(value: string): DriveQueryBuilder;
  modifiedAfter(value: string): DriveQueryBuilder;
  modifiedBefore(value: string): DriveQueryBuilder;
  restrictToMarkdownSidecars(): DriveQueryBuilder;
  build(): string;
}

interface DriveQueryHelpers {
  builder(): DriveQueryBuilder;
  raw(query: string): DriveQueryBuilder;
  restrictToMarkdownSidecars(query: string): string;
}
```

Example folder-scoped search:

```ts
const q = drive.q
  .builder()
  .inParents("<folder-id>")
  .fullTextContains("incident review")
  .restrictToMarkdownSidecars()
  .build();

const result = await drive.query({
  q,
  corpora: "drive",
  driveId: "<shared-drive-id>",
  pageSize: 25,
});
```

`restrictToMarkdownSidecars(...)` should only append Drive-native clauses such
as:

```ts
mimeType = 'text/markdown' and name contains '.index.md'
```

It should not fetch notebook JSON files or reshape response objects. That work
belongs in a separate result-resolution helper.

### `drive.open`

`drive.open` should fetch a Drive document by stable URI/ID and return only
readable content and metadata. It must not mutate notebook state or local
selection state as a side effect.

Recommended behavior:

- Accept canonical Drive file URLs or raw file IDs and normalize them through
  the existing Drive URI parser.
- For `format: "metadata"`, return metadata only.
- For `format: "text"`, fetch media bytes and return decoded text for text-like
  MIME types (`text/markdown`, `text/plain`, `application/json`), with a byte
  limit and `truncated=true` when clipped.
- For `format: "notebookJson"`, return notebook JSON text for the canonical
  notebook file.
- Reject folders for content reads but still allow metadata opens on folders.

## Sidecar Resolution Design

Query result post-processing should also be separate from `drive.query(...)`.
That avoids mixing "what Drive should search" with "how Runme interprets the
matches".

Proposed helper:

```ts
type DriveNotebookMatch = {
  notebook: DriveQueryMatch;
  sidecar: DriveQueryMatch;
  resolution: "resolved" | "missing" | "ambiguous";
  candidates?: DriveQueryMatch[];
};

interface DriveResultResolvers {
  resolveNotebookSidecars(matches: DriveQueryMatch[]): Promise<DriveNotebookMatch[]>;
}
```

Example:

```ts
const sidecarMatches = await drive.query({
  q: drive.q.restrictToMarkdownSidecars(
    "fullText contains 'feature flag cleanup'",
  ),
  pageSize: 10,
});

const notebookMatches = await drive.results.resolveNotebookSidecars(
  sidecarMatches.matches,
);

for (const match of notebookMatches) {
  if (match.resolution !== "resolved") {
    continue;
  }
  const notebook = await drive.open({
    uri: match.notebook.uri,
    format: "notebookJson",
    maxBytes: 512_000,
  });
  console.log(notebook.text);
}
```

### v0: naming-based resolution

For each Markdown sidecar hit named `<basename>.index.md`:

- read its parent folder IDs from Drive metadata,
- derive candidate notebook filename `<basename>.json`,
- query siblings in the same parent folder for that exact name and notebook
  MIME type,
- if exactly one notebook match exists, return that notebook URI as `uri` and
  the sidecar URI as `matchedSidecarUri`,
- if zero or multiple notebook matches exist, return the sidecar itself as
  `uri` and leave notebook resolution to a follow-up `open`.

This is easy to implement with today's storage model but can be ambiguous when
duplicate sibling names exist.

### v1: explicit linkage with `appProperties`

When writing sidecars, also set Drive app properties such as:

```ts
// On notebook JSON file
appProperties: {
  runmeRole: "notebook",
  runmeMarkdownSidecarId: "<sidecar-file-id>",
}

// On Markdown sidecar file
appProperties: {
  runmeRole: "markdownSidecar",
  runmeNotebookId: "<notebook-file-id>",
}
```

Then `drive.results.resolveNotebookSidecars(...)` can resolve sidecar hits to
notebook files deterministically without relying on sibling-name inference.

## Alternatives Considered

### Use the built-in Google Drive connector in the Responses API

OpenAI's Responses API supports first-party connectors, including Google Drive,
as documented in the
[Connectors and MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp?quickstart-panels=connector#connectors).

In that design, the `responses-direct` harness would delegate Drive search and
document fetch to the model's connector tool calls instead of exposing a
Runme-owned `drive` API in AppKernel.

Why this is likely not the right default for Runme:

- Less control over the agent-facing API surface. We are limited to the
  connector functions OpenAI exposes, which is enough for basic search/fetch but
  harder to extend with Runme-specific notebook semantics, sidecar resolution,
  or future write workflows.
- We already plan to give the agent a JavaScript execution environment in
  AppKernel / code mode. A Drive JS library is a richer and more extensible
  interface than a fixed connector tool set, especially once the agent needs to
  compose Drive search, notebook inspection, and Runme-specific helper logic in
  one program.
- A connector-centric design helps only the `responses-direct` harness. A
  Runme-owned JS API can be made harness-independent and reused by both
  `responses-direct` and `codex`.

Main downside of the Runme-owned JS API approach:

- We may need to build and maintain more of the agentic loop/tool orchestration
  ourselves instead of relying on the connector stack to provide that behavior.

Current recommendation:

- Prefer the Runme-owned `drive.query`, `drive.q`, `drive.results`, and
  `drive.open` AppKernel API as the primary design.
- Keep the built-in Responses Google Drive connector as a fallback or future
  implementation option if we discover that maintaining a custom agentic Drive
  loop is more costly than expected.

## Safety and Policy

This interface should be intentionally read-only.

- Do not expose `create`, `save`, `saveContent`, `rename`, `copy`, `share`, or
  `delete` through the agent-facing `drive` namespace.
- Use the user's existing Drive auth context and request only read scopes for
  agent search/open.
- Do not let `open` fetch arbitrary URLs; only Drive file IDs/URLs accepted by
  the existing Drive parser should be allowed.
- Cap `pageSize`, response bytes, and `open.maxBytes` so a broad search or a
  large notebook cannot flood the tool response.
- Keep a fixed metadata field mask so the model cannot use `fields` to ask for
  unexpected Drive resource fields.
- Emit structured errors for malformed `q`, unsupported MIME types, folder
  content reads, missing files, and permission-denied responses.

## Implementation Plan

1. Add a small read-only Drive client method layer around the existing
   Drive files client:
   - `queryFiles(request)` -> `files.list`
   - `openFileMetadata(uri)` -> `files.get(fields=...)`
   - `openFileText(uri, maxBytes)` -> `files.get(alt=media)`
2. Add sidecar-aware query resolution:
   - implement `drive.q.restrictToMarkdownSidecars(...)`,
   - implement `drive.results.resolveNotebookSidecars(...)`,
   - start with naming-based sidecar-to-notebook resolution.
3. Expose a read-only `drive.query` and `drive.open` AppKernel API for
   code-mode agent flows.
4. Update agent instructions/tool docs to teach this pattern:
   - use Drive `q` directly,
   - search Markdown sidecars for notebook text,
   - open canonical notebook files for final inspection.
5. Add tests against the fake Drive server and at least one manual Drive CUJ
   notebook covering sidecar search and notebook open.
6. Consider a v1 sidecar schema migration to persist reciprocal Drive
   `appProperties` links and remove naming-based ambiguity.

## Test Plan

- Unit test Drive query parameter forwarding and response normalization.
- Unit test sidecar-to-notebook resolution for unique, missing, and duplicate
  sibling matches.
- Unit test `open` truncation, MIME filtering, and folder rejection.
- Integration test fake Drive search over `.index.md` sidecars and opening the
  resolved notebook JSON file.
- Manual CUJ test against real Drive:
  - create/save a Drive notebook,
  - wait for sidecar sync,
  - search by notebook body text through `drive.query`,
  - open the returned notebook through `drive.open`,
  - verify no write operation is available from the agent API.

## Open Questions

- Should `drive.open(format: "notebookJson")` return raw notebook JSON text,
  parsed notebook objects, or both?
- Should `drive.results.resolveNotebookSidecars(...)` hide sidecars completely
  when notebook resolution fails, or return sidecar hits with explicit
  ambiguity metadata?
- Do we want a dedicated `drive.queryNotebookText(...)` convenience wrapper, or
  is `drive.query(...)` plus `drive.results.resolveNotebookSidecars(...)`
  enough?
- Should AppKernel expose this as direct JS helpers only, or also generate
  first-class MCP tools from a proto contract?
