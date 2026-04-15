# 20260415 Agentic Search

## Status

Draft proposal.

## Summary

Add low-level browser capabilities to the `codex-wasm` harness so the agent
can answer questions about Runme by fetching public Runme sources from GitHub,
caching them locally, and searching those cached files with a workflow that
feels closer to `ripgrep` (`rg`) than to semantic retrieval.

The v0 platform should provide:

- policy-governed `fetch` for remote reads,
- policy-governed OPFS primitives for local persistence,
- enough browser runtime context for the agent to write JavaScript that fetches
  manifests, downloads files, persists them, and searches them,
- a path for the agent to retain reusable snippets and patterns via memory.

The key design choice is to separate:

1. low-level sandbox capabilities,
2. policy over those capabilities,
3. optional higher-level SDKs that may emerge later.

This document now recommends shipping the low-level capability substrate first
and deferring bespoke search SDK design until we see what patterns the agent
actually converges on.

## Problem

Today the browser-local agent harness can execute code in sandboxed AppKernel,
but it does not have a strong way to answer "How does Runme work?" or "Where is
X implemented?" by consulting the Runme docs and codebase.

For `codex-wasm`, we want something closer to Codex searching a local checkout:

1. find candidate files quickly,
2. show path + snippet + line context,
3. open the best file for deeper inspection,
4. avoid repeatedly downloading the same corpus.

The browser environment changes a few constraints:

- the corpus is remote and must be fetched,
- the cache must live in browser storage,
- we should not assume shell access or the `ripgrep` (`rg`) binary,
- the agent still needs concrete instructions about which sources exist and how
  to query them.

## Goals

- Let `codex-wasm` answer Runme product and implementation questions using
  Runme docs and source.
- Support at least the public `runmedev/web` repository in v0.
- Expose low-level browser capabilities that let sandboxed agent-authored code
  fetch, persist, and search corpus data without human approval inside policy.
- Cache fetched text locally in the browser.
- Return or derive stable source URIs, file paths, and snippets.
- Make policy the primary control point for safety.
- Make the storage and search design compatible with future private or
  user-mounted corpora.
- Leave room for higher-level SDKs once real agent usage shows which
  abstractions are worth standardizing.

## Non-Goals

- No mutation of remote GitHub content.
- No semantic/vector retrieval system in v0.
- No unrestricted network or filesystem access outside policy.
- No attempt to mirror every Git object or preserve a full local git checkout.
- No general web crawler in v0.
- No requirement to design a bespoke host-provided search SDK before the agent
  can search.

## Initial Corpus Scope

For v0, the initial unattended corpus should be the public `runmedev/web`
repository at `main`.

This is not meant to introduce a new host-owned source abstraction. It is
simply the initial policy/config choice for what the sandboxed agent is allowed
to fetch and cache without approval.

Recommended scope:

- GitHub tree manifests under `https://api.github.com/repos/runmedev/web/`
- raw file content under `https://raw.githubusercontent.com/runmedev/web/main/`

with an allowlist roughly like:

- `docs/**`
- `docs-dev/**`
- `app/src/**`
- `packages/**`
- top-level text files such as `README*`, `AGENTS.md`, `package.json`,
  `pnpm-lock.yaml`

and excludes for:

- `node_modules/**`
- generated protobuf output where not useful for product questions
- binary assets, large media, and build output

This keeps the first corpus aligned with the questions we expect users to ask
about Runme while avoiding low-value files, without requiring a broader
source-root abstraction in v0.

## Minimum Low-Level Capability

The transport primitive can be plain HTTP `GET`, but raw blob `GET` alone is
not enough to recurse a repository.

There are two cases:

1. `GET` against a known file URL such as
   `raw.githubusercontent.com/.../path/to/file.md` is sufficient to fetch one
   blob.
2. To crawl a repo, the runtime also needs a `GET`-addressable manifest or tree
   endpoint that lists paths under a revision.

So the correct answer is:

- `GET` is sufficient as a transport primitive,
- but only if the runtime can call endpoints that return directory/tree
  metadata,
- and only if the host already knows how to turn those results into file fetch
  URLs.

For GitHub public repos, the runtime should use:

- a tree/contents manifest endpoint to enumerate files at a ref,
- raw file fetch URLs to fetch file contents.

The model should not be asked to discover GitHub URL conventions or recurse an
HTML directory listing on its own.

### GitHub tree enumeration details

For v0, the preferred enumeration endpoint is the GitHub Git Trees API:

```text
GET https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1
```

Example:

```text
GET https://api.github.com/repos/runmedev/web/git/trees/main?recursive=1
```

Important behavior:

- with `recursive=1`, the response includes descendants under the requested
  tree,
- entries with `type: "blob"` are files,
- entries with `type: "tree"` are directories,
- for `blob` entries, `path` is already the canonical repo-relative file path.

Example `blob` entry:

```json
{
  "path": "docs/design/20260331_remove_chatkit_responses_runme_converter.md",
  "mode": "100644",
  "type": "blob",
  "sha": "...",
  "url": "https://api.github.com/repos/runmedev/web/git/blobs/..."
}
```

In this case, the canonical repo-relative file path is simply:

```text
docs/design/20260331_remove_chatkit_responses_runme_converter.md
```

The runtime should persist that `path` value directly in search metadata.

If the runtime uses a non-recursive tree response instead, then each `tree`
entry represents a directory. In that mode, full file paths must be built by
recursing into child tree URLs and joining parent `path` values with descendant
paths. We should avoid that extra complexity in v0 unless the recursive tree
response is truncated.

For content fetches, prefer raw GitHub URLs built from the repo, ref, and
repo-relative `path`:

```text
https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
```

Example:

```text
https://raw.githubusercontent.com/runmedev/web/main/docs/design/20260331_remove_chatkit_responses_runme_converter.md
```

The `url` field in the tree response is a Git object API URL, not the
canonical file path and not the preferred file-content URL for this design.

## Capability Layers

This design should separate three layers.

### 1) Sandbox primitives

These are the low-level capabilities available to sandboxed AI-generated
JavaScript without human approval, subject to policy.

Recommended v0 primitives:

- `fetch` for remote reads
- OPFS file and directory operations
- structured `postMessage` bridges that implement those primitives inside the
  existing sandbox kernel

Representative OPFS-oriented API shape:

```ts
type OpfsApi = {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<Array<{ name: string; kind: "file" | "directory" }>>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ kind: "file" | "directory"; size?: number; mtime?: string }>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
};

type FetchApi = {
  fetch(input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }): Promise<{
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    text?: string;
    bytes?: Uint8Array;
  }>;
};
```

These are intentionally low-level. They are enough for the agent to:

1. fetch a GitHub tree manifest,
2. iterate over entries,
3. fetch individual files,
4. persist them in OPFS,
5. build its own lexical scan or local index in JavaScript.

### 2) Policy

Policy is the primary safety boundary.

For this design, policy should answer:

- which HTTP methods are allowed without approval,
- which URI prefixes/domains are allowed,
- what response size, timeout, and content-type limits apply,
- which OPFS paths are writable,
- which operations require approval.

Example v0 policy posture:

- allow `GET` to:
  - `https://api.github.com/repos/runmedev/web/`
  - `https://raw.githubusercontent.com/runmedev/web/`
- deny or require approval for `POST`, `PUT`, `PATCH`, `DELETE`
- allow OPFS reads/writes under a harness-owned prefix such as
  `/agent-cache/runmedev-web/`
- enforce maximum response size and per-file size limits

This is the right place to control exfiltration risk. The question is not
whether the agent has raw primitives; the question is what those primitives are
allowed to touch without approval.

### 3) Higher-level SDKs

Higher-level helpers may still be useful, but they are a separate decision.

Examples:

- a GitHub tree walker,
- a blob cache helper,
- a line-index builder,
- a lexical search helper,
- a refresh/checkpoint helper.

This document does not recommend requiring those SDKs in v0. The initial
expectation should be that the agent writes JavaScript using the low-level
primitives above, and that reusable patterns can later be standardized once we
observe what the agent actually needs.

## Recommended GitHub Retrieval Flow

Rather than expose a bespoke host search service immediately, v0 should assume
the agent writes JavaScript that performs the following flow:

1. fetch the GitHub recursive tree manifest for the target ref,
2. filter entries to `type === "blob"` and allowed paths,
3. derive raw content URLs from `{owner, repo, ref, path}`,
4. fetch file contents,
5. write normalized blobs into OPFS,
6. scan cached blobs lexically or build a local index over them.

That keeps the platform substrate small while still supporting rich retrieval
behaviors.

## Browser Storage Design

Use a hybrid layout:

- IndexedDB via Dexie for metadata, manifests, and optional index tables.
- OPFS for raw normalized blob bodies, derived artifacts, and agent-authored
  cache state.

This fits the existing repo shape:

- the web app already uses Dexie-backed stores such as
  `runme-local-notebooks` and `runme-fs-workspaces`,
- the app already has `ensurePersistentStorage()` for requesting persistent
  browser storage,
- OPFS gives better behavior for larger file-like blobs than storing every body
  directly inside IndexedDB rows.

For this design, OPFS is not hidden from the agent behind a host-owned search
service. OPFS is part of the substrate the sandboxed agent uses to persist its
own cache and derived files.

### Proposed Local Schema

```ts
type SearchBlobRecord = {
  uri: string;           // e.g. github://runmedev/web/main/app/src/...
  rootId: string;
  path: string;
  revision: string;
  sha?: string;
  sizeBytes: number;
  fetchedAt: string;
  contentType: string;
  bodyKey: string;       // OPFS path or content-addressed key
  lineIndexKey?: string; // optional derived line-offset table
};

type SearchRootStateRecord = {
  id: string;
  title: string;
  kind: string;
  revision?: string;
  syncedAt?: string;
  lastSyncError?: string;
};
```

Recommended layout:

- Dexie table `searchRoots`
- Dexie table `searchBlobs`
- OPFS directory `search-blobs/`
- OPFS directory `search-derived/`
- OPFS directory `search-memories/` or similar scratch area for reusable
  agent-authored helper code if we decide to persist snippets locally

If OPFS is unavailable, fall back to storing small bodies in IndexedDB so the
feature still works, just less efficiently.

### OPFS API surface

At the browser level, OPFS is reached through:

- `navigator.storage.getDirectory()`

which returns a `FileSystemDirectoryHandle` for the origin-private root. The
underlying platform APIs include:

- `getDirectoryHandle(...)`
- `getFileHandle(...)`
- `entries()`, `keys()`, `values()`
- `removeEntry(...)`
- `FileSystemFileHandle.getFile()`
- `FileSystemFileHandle.createWritable()`
- `FileSystemFileHandle.createSyncAccessHandle()` in dedicated workers

The sandbox kernel does not need to expose those browser objects directly. It
can expose a simpler RPC-style OPFS API over `postMessage` that maps onto them.

## Search Strategy

### V0: Ripgrep-Style Scan Over Cached Blobs

Do not make a full-text index a prerequisite for v0.

For the first corpus size, agent-authored JavaScript running in the browser can
scan cached text blobs fast enough if we keep the corpus narrow and text-only.
This is closer to the `ripgrep` mental model the user already has:

- query a cached corpus,
- return file/line/snippet matches,
- open the file if needed.

Implementation outline:

1. fetch and maintain normalized text blobs,
2. maintain per-file line offsets or compute them on demand,
3. execute substring or regex search in a worker-friendly loop,
4. collect top matches,
5. rank by:
   - exact path/name hits first,
   - then exact text matches,
   - then shorter path distance and fresher files.

This avoids premature complexity and gives us a direct baseline for latency.

### V1: Optional Incremental Local Index

If warm-cache search latency is not good enough, add an incremental inverted
index over the same blob corpus.

Recommended first index shape:

- tokenize normalized text into lowercase terms,
- store `(term -> [uri, positions])` postings in IndexedDB,
- optionally add a trigram index for substring queries.

We should not start with embeddings or vector search. The dominant query style
for code/docs lookup is still lexical:

- API names,
- config keys,
- file names,
- URLs,
- feature labels,
- exact phrases from errors or UI text.

## Sync and Freshness Model

The runtime should support revision-aware caches per root, but v0 should assume
the first cache manager is agent-authored JavaScript running on top of the
low-level primitives.

Recommended policy:

1. on first use, sync the root manifest,
2. fetch blobs lazily as the agent searches/opens,
3. opportunistically prefetch high-value files under `docs/`, `docs-dev/`, and
   `README*`,
4. on later turns, compare the root revision and only refetch changed files.

For GitHub-backed roots, the cache key should include:

- repo identity,
- ref or resolved commit SHA,
- path,
- blob SHA when available.

Agent-authored search code should preserve freshness metadata so the agent can
say whether it searched cached data from a specific sync time or revision.

## Query UX for the Agent

The derived search results should look like a code search tool, not like
document retrieval.

Example result:

```json
{
  "matches": [
    {
      "uri": "github://runmedev/web/main/app/src/lib/runtime/codexWasmSession.ts",
      "rootId": "github://runmedev/web?ref=main",
      "path": "app/src/lib/runtime/codexWasmSession.ts",
      "line": 16,
      "snippet": "const RUNME_CODE_MODE_PROMPT_PREFIX = ["
    }
  ]
}
```

This is the important behavioral point: the model should search by terms that
look like how engineers search locally, even if the initial implementation is a
library the agent writes for itself rather than a built-in host tool.

Examples:

- search for `"codex wasm prompt"` under cached `app/src/**`
- search for `"ExecuteCode"` under cached `app/src/**`
- search for `"Runme public docs"` under cached `docs/**`

## Codex WASM Harness Integration

For this design, the important integration point is not a native search tool.
It is the low-level capability bridge exposed to sandboxed JavaScript in the
`codex-wasm` harness.

Rationale:

- safety is controlled by policy over the bridge,
- the agent can evolve its own retrieval code rather than waiting for bespoke
  host SDKs,
- the same substrate can later support more than GitHub search,
- AppKernel code mode remains the place where agent-authored JS runs.

Recommended layering:

1. `codex-wasm` exposes low-level `fetch` + OPFS capabilities into sandboxed
   code mode.
2. Policy enforcement happens at the kernel/bridge boundary.
3. Agent-authored JS performs crawl/cache/search work.
4. Later host SDKs remain optional and can be added once justified by usage.

## System and User Instruction Shape

The harness should tell Codex three things clearly:

1. what low-level capabilities exist,
2. what policy boundaries apply,
3. what known corpora or URL patterns are expected.

Recommended system prompt addition:

```text
You are operating inside the Runme app ChatKit panel in a browser.
Sandboxed JavaScript can make policy-approved fetch requests and can persist
files in origin-private browser storage. Use those capabilities to fetch Runme
source manifests and files, cache them locally, and search them lexically when
the user asks how Runme works, where a feature is implemented, or what a Runme
document says.

Allowed sources for unattended reads include:
- https://api.github.com/repos/runmedev/web/
- https://raw.githubusercontent.com/runmedev/web/

Persist reusable cache state under the approved OPFS prefix. Preserve revision
and path metadata so you can explain freshness and provenance in your answer.
```

If we add more allowed corpora later, include them explicitly in the prompt and
policy configuration rather than expecting the model to infer them.

The user-facing prompt does not need to teach OPFS internals, but the system
prompt should make the runtime capability model explicit.

## V0 Recommendation

For the first version, do the following:

1. Expose policy-governed `fetch` primitives to sandboxed JS.
2. Expose policy-governed OPFS primitives to sandboxed JS.
3. Add policy for unattended `GET` access to the relevant GitHub endpoints for
   `runmedev/web`.
4. Request persistent browser storage when available.
5. Seed the system prompt with the approved URL prefixes and cache/freshness
   expectations.
6. Expect the agent to write JS that fetches the GitHub tree manifest, downloads
   files, writes them to OPFS, and searches them lexically.
7. Invest early in browser/Codex memory so the agent can retain and reuse those
   snippets rather than rediscovering them every session.

This is enough to answer "what is Runme?", "where is codex-wasm implemented?",
"what do the design docs say about Drive agentic search?", and similar
questions without introducing a full search engine or bespoke retrieval SDK
first.

## Why This Is Better Than Starting With an Index

The strongest argument for this design is that it gives us the right capability
surface early:

- explicit safety and policy boundaries,
- a reusable browser substrate for fetch + persistence,
- room for the agent to evolve retrieval code,
- prompt instructions aligned with the actual runtime.

If we start by designing an index or a host-owned search SDK before we have
those pieces, we risk solving the wrong problem. `ripgrep` is effective because
lexical search over files is a strong workflow; the browser equivalent should
first make that workflow possible.

## Open Questions

- Should v0 policy allow only `runmedev/web`, or should it include another
  public Runme repo?
- Do we want background warmup for high-value files on app load, or only after
  the first Runme-related question?
- Should the initial agent-authored search library support regex in v0, or
  should it start with substring plus path filtering only?
- Is revision checking done on every turn, or only when the user explicitly
  asks for refresh/current data?
- What memory mechanism should Codex/browser use to preserve reusable
  crawl/cache/search snippets across sessions?
- At what point should agent-evolved patterns graduate into first-class SDKs or
  tools owned by the host runtime?

## Implementation Sketch

1. Add sandbox-kernel RPCs for policy-governed `fetch`.
2. Add sandbox-kernel RPCs for policy-governed OPFS operations.
3. Add policy configuration for allowed GitHub URL prefixes, methods, and size
   limits.
4. Add Dexie metadata tables for manifests and cached blobs.
5. Add an OPFS-backed cache layout for fetched blob bodies and derived files.
6. Extend the `codex-wasm` prompt prefix with the capability/policy guidance.
7. Build or enable a memory path for Codex/browser to retain reusable
   crawl/cache/search snippets.

## References

- [20260403 Drive Agentic Search](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260403_drive_agentic_search.md)
- [20260414 Codex WASM Harness](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260414_codex_wasm.md)
- [20260331 Code Mode](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260331_code_mode.md)
