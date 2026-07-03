# 20260403 Drive Agentic Search

## Status

Draft proposal. Modified on 2026-07-03 to clarify alternatives around direct
`gapi` exposure and the current `drive.search` implementation direction.

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

The current MVP, implemented by PR #274, exposes `drive.search(...)` in the
existing AppKernel `drive` namespace. `drive.search` is a Runme wrapper around
Google Drive v3 `files.list`: it accepts the native list request shape, forwards
the request to Drive, preserves paging metadata, and adds a Runme-compatible
`uri` to returned files when the caller includes `id` and `mimeType` in the
requested fields.

The longer-term read-oriented agent surface should add `drive.open(...)`,
query-building helpers, sidecar resolution helpers, and stronger guardrails.

```ts
type DriveSearchRequest = {
  // Native Google Drive v3 files.list parameters.
  q?: string;
  fields?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  corpora?: "user" | "drive" | "domain" | "allDrives";
  driveId?: string;
  includeItemsFromAllDrives?: boolean;
  supportsAllDrives?: boolean;
  spaces?: string;
  [key: string]: unknown;
};

type DriveSearchFile = {
  uri?: string;
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
  [key: string]: unknown;
};

type DriveSearchResponse = {
  files: DriveSearchFile[];
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
  search(request: DriveSearchRequest): Promise<DriveSearchResponse>;

  // Future follow-up.
  open(request: DriveOpenRequest): Promise<DriveOpenResponse>;
}
```

### `drive.search`

`drive.search` should pass the caller's request directly to Drive `files.list`
so App Console, WebMCP, and Codex code mode can use Drive's native `q`
expression, field masks, shared-drive parameters, pagination, and ordering.

PR #274 intentionally keeps the request surface close to `files.list` rather
than inventing a custom search DSL. It does, however, keep Drive client details
behind Runme's Drive store and enriches results with Runme URIs.

Recommended behavior:

- Preserve caller-supplied `q`, `fields`, `pageSize`, `pageToken`,
  `corpora`, `driveId`, `spaces`, shared-drive options, and `orderBy`.
- Add stable canonical Drive URIs built from file IDs when results include
  `id` and `mimeType`.
- Encourage callers to request explicit fields such as
  `nextPageToken,incompleteSearch,files(id,name,mimeType,parents,modifiedTime)`.
- In a follow-up, cap `pageSize` to a safe maximum and consider a conservative
  default `fields` value when callers omit one.
- In a follow-up, default `supportsAllDrives=true` and
  `includeItemsFromAllDrives=true` if that proves more ergonomic for shared
  Drive notebooks.

`drive.list(folderIdOrUri)` is separate from `drive.search(...)`.
`drive.list` is a folder-browsing convenience API for the Explorer and returns
`NotebookStoreItem` objects. Internally it can be implemented using
`drive.search` with a fixed parent-folder query, but callers should use
`drive.search` when they need the general Drive query/list surface.

### Query builder helpers

Instead of a `mode` argument, query shaping should happen before calling
`drive.search(...)` using composable helpers that return native Drive `q`
strings.

This keeps `drive.search` itself aligned with Drive's API while still making
common query patterns easy to express and chain.

Example helper API:

```ts
const q = drive.q
  .raw("fullText contains 'SLO burn rate'")
  .and("modifiedTime >= '2026-01-01T00:00:00'")
  .restrictToMarkdownSidecars()
  .build();

const result = await drive.search({
  q,
  orderBy: "modifiedTime desc",
  pageSize: 20,
});
```

Equivalent functional style:

```ts
const result = await drive.search({
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

const result = await drive.search({
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

Query result post-processing should also be separate from `drive.search(...)`.
That avoids mixing "what Drive should search" with "how Runme interprets the
matches".

Proposed helper:

```ts
type DriveNotebookMatch = {
  notebook: DriveSearchFile;
  sidecar: DriveSearchFile;
  resolution: "resolved" | "missing" | "ambiguous";
  candidates?: DriveSearchFile[];
};

interface DriveResultResolvers {
  resolveNotebookSidecars(files: DriveSearchFile[]): Promise<DriveNotebookMatch[]>;
}
```

Example:

```ts
const sidecarMatches = await drive.search({
  q: drive.q.restrictToMarkdownSidecars(
    "fullText contains 'feature flag cleanup'",
  ),
  pageSize: 10,
});

const notebookMatches = await drive.results.resolveNotebookSidecars(
  sidecarMatches.files,
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

### Expose the raw `gapi.client.drive.files.list` API

Another option is to make the dynamically loaded Google API client directly
available in App Console and code mode, for example by exposing
`gapi.client.drive.files.list(...)` to agent-authored JavaScript.

That approach is not the right default for Runme:

- It leaks the implementation detail that the current browser Drive client is
  backed by Google's dynamically generated `gapi` client. Runme also uses
  fetch-backed Drive clients in tests and service-account flows, and the
  AppKernel API should not force callers to know which client is active.
- It exposes a broad generated client object rather than a small, reviewed
  Runme-owned surface. That makes it easier to accidentally expose write,
  share, copy, or delete methods alongside read-only search.
- It does not return Runme-native identifiers. Search results still need
  post-processing to add stable Drive file/folder URIs that can be passed to
  `notebooks.show(...)`, sidecar resolution helpers, and other Runme APIs.
- It gives Runme no clean place to add logging, auth refresh behavior, response
  size limits, field-mask defaults, or future safety guardrails.
- It couples agent examples and user docs to a generated third-party API shape
  rather than a stable Runme API.

Current recommendation:

- Keep `gapi` and other Drive clients behind `DriveNotebookStore` and expose a
  small Runme API such as `drive.search(...)`.
- Preserve the native Drive `files.list` request shape at that boundary so the
  agent still gets Drive's full query expressiveness.

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

- Prefer the Runme-owned `drive.search`, `drive.q`, `drive.results`, and
  `drive.open` AppKernel API as the primary design.
- Keep the built-in Responses Google Drive connector as a fallback or future
  implementation option if we discover that maintaining a custom agentic Drive
  loop is more costly than expected.

## Safety and Policy

The long-term agent-facing interface should be intentionally read-oriented.
PR #274 adds a read-oriented `drive.search` method to the existing AppKernel
`drive` namespace, but that namespace also contains broader App Console helpers
for user-driven Drive operations. Future Codex-specific or policy-specific
exposure should keep the agent's default Drive surface narrower than the full
App Console surface.

- Do not expose `create`, `save`, `saveContent`, `rename`, `copy`, `share`, or
  `delete` through a default agent-facing read surface.
- Use the user's existing Drive auth context and request only read scopes for
  agent search/open.
- Do not let `open` fetch arbitrary URLs; only Drive file IDs/URLs accepted by
  the existing Drive parser should be allowed.
- Preserve Drive's native `files.list` request expressiveness for
  `drive.search`, but add practical limits in a follow-up: cap `pageSize`, set
  a conservative default `fields` mask when omitted, and cap returned output
  bytes.
- Cap `open.maxBytes` so a large notebook cannot flood the tool response.
- Emit structured errors for malformed `q`, unsupported MIME types, folder
  content reads, missing files, and permission-denied responses.

## Implementation Plan

1. Add a small Drive client method layer around the existing Drive files client:
   - `searchFiles(request)` / `drive.search(request)` -> `files.list`
   - `openFileMetadata(uri)` -> `files.get(fields=...)`
   - `openFileText(uri, maxBytes)` -> `files.get(alt=media)`
2. PR #274 implements the first search/list part:
   - forward the native Drive `files.list` request shape,
   - preserve `nextPageToken` and `incompleteSearch`,
   - add Runme `uri` values when returned files include `id` and `mimeType`,
   - expose the method in App Console and WebMCP/code-mode sandbox as
     `drive.search(...)`.
3. Add sidecar-aware query resolution:
   - implement `drive.q.restrictToMarkdownSidecars(...)`,
   - implement `drive.results.resolveNotebookSidecars(...)`,
   - start with naming-based sidecar-to-notebook resolution.
4. Add `drive.open(...)` for read-only metadata/text/notebook JSON fetches.
5. Add follow-up guardrails for the agent-facing path:
   - cap `pageSize`,
   - default or constrain `fields` where appropriate,
   - cap returned output bytes,
   - keep write helpers out of the default agent read surface.
6. Update agent instructions/tool docs to teach this pattern:
   - use Drive `q` directly,
   - search Markdown sidecars for notebook text,
   - open canonical notebook files for final inspection.
7. Add tests against the fake Drive server and at least one manual Drive CUJ
   notebook covering sidecar search and notebook open.
8. Consider a v1 sidecar schema migration to persist reciprocal Drive
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
  - search by notebook body text through `drive.search`,
  - open the returned notebook through `drive.open`,
  - verify no write operation is available from the agent API.

## Open Questions

- Should `drive.open(format: "notebookJson")` return raw notebook JSON text,
  parsed notebook objects, or both?
- Should `drive.results.resolveNotebookSidecars(...)` hide sidecars completely
  when notebook resolution fails, or return sidecar hits with explicit
  ambiguity metadata?
- Do we want a dedicated `drive.queryNotebookText(...)` convenience wrapper, or
  is `drive.search(...)` plus `drive.results.resolveNotebookSidecars(...)`
  enough?
- Should AppKernel expose this as direct JS helpers only, or also generate
  first-class MCP tools from a proto contract?
