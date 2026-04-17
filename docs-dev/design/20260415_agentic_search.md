# 20260415 Agentic Search

## Status

Draft proposal.

## Summary

Add low-level browser capabilities to the `codex-wasm` harness so the agent
can answer questions about Runme by fetching public Runme sources from GitHub,
caching them locally, and searching those cached files with a workflow that
feels closer to `ripgrep` (`rg`) than to semantic retrieval.

The v0 platform should provide:

- `GET`-oriented network reads for remote fetches,
- OPFS primitives for local persistence,
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

## Background

### What native Codex already does

In the native Codex codebase, project-level instructions are pulled from
`AGENTS.md` files and appended to the user instructions. The implementation is
in [`project_doc.rs`](/Users/jlewi/code/codex/codex-rs/core/src/project_doc.rs).
It walks from repo root to cwd, reads `AGENTS.md`, and injects that text into
the prompt.

Native Codex also exposes general-purpose tools such as shell/command tools and
optionally `js_repl`. The `js_repl` instructions explicitly tell the model to
use `codex.tool(...)` to call normal tools, including shell tools, from inside
JavaScript.

That means native Codex usually gets filesystem context in one of three ways:

- prompt context from `AGENTS.md`,
- shell-style inspection of the local checkout with tools like `rg`, `find`,
  `sed`, and `cat`,
- JavaScript that calls those tools through `codex.tool(...)` when `js_repl` is
  enabled.

There is a `codex-file-search` crate in the Codex repo, but it is currently
used for fuzzy file search in the TUI and app-server UI flows. It is not the
primary model-facing filesystem retrieval mechanism that the browser harness can
simply inherit.

### What the current WASM harness actually does

The current browser harness in
[`codex-rs/wasm-harness/src/browser.rs`](/Users/jlewi/code/codex/codex-rs/wasm-harness/src/browser.rs)
starts a real `CodexThread` and injects one browser-side code executor. The
browser-facing API is:

- `new BrowserCodex(apiKey)`
- `set_api_key(...)`
- `set_code_executor(...)`
- `submit_turn(prompt, on_event)`

Important current limitations:

- the WASM build does not automatically read project docs; the wasm variant in
  [`project_doc_wasm.rs`](/Users/jlewi/code/codex/codex-rs/core/src/project_doc_wasm.rs)
  returns `None`,
- the exec-server filesystem implementation on wasm is unsupported,
- nested code-mode tools are disabled on wasm because
  `build_enabled_tools(...)` returns an empty list under `#[cfg(target_arch =
  "wasm32")]`.

So the browser harness does not currently inherit desktop Codex's filesystem
or shell-oriented retrieval surface. We have to provide that browser runtime
context ourselves.

### What output Code Mode returns to the model

In the WASM harness, the JS executor returns JSON of the form:

```json
{
  "output": "...",
  "stored_values": {},
  "error_text": null
}
```

`BrowserCodeModeRuntime` turns `output` into a
`FunctionCallOutputContentItem::InputText`, and Codex prepends a status header
such as `Script completed` and wall time before sending the tool result back to
the model.

In the current Runme integration, that `output` string comes from
[`codeModeExecutor.ts`](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codeModeExecutor.ts),
which captures stdout and stderr from the sandbox JS kernel and returns one
merged output string. In practice, that means code-mode output is effectively
"whatever the code printed to stdout/stderr", plus the Codex status wrapper.

## Goals

- Let `codex-wasm` answer Runme product and implementation questions using
  Runme docs and source.
- Support at least the public `runmedev/web` repository in v0.
- Expose low-level browser capabilities that let sandboxed agent-authored code
  fetch, persist, and search corpus data without human approval in v0.
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

## Proposal

### Overview

For v0, we should assume the agent answers Runme questions by writing
JavaScript in AppKernel against low-level browser APIs, not by calling a
host-owned search SDK.

The intended flow for a question such as "How do you configure a runner in
Runme?" is:

1. The harness prompt tells the agent that public Runme source lives in
   `runmedev/web` and that cached repos should be laid out in OPFS under
   `/code/${ORG}/${REPO}`.
2. The agent writes JS that checks whether `/code/runmedev/web` already exists
   in OPFS.
3. If the repo is missing or stale, the agent uses policy-approved network reads
   to fetch the GitHub tree manifest for `runmedev/web@main`, iterates the
   returned `blob` entries, fetches relevant files, and writes them into
   `/code/runmedev/web/...`.
4. The agent writes JS that recursively walks files under that cached tree,
   applies lexical matching with JavaScript regexes or substring checks, and
   finds relevant sections in docs and source.
5. The agent prints or otherwise returns the matched snippets and paths through
   code-mode output.
6. Codex then uses those snippets as immediate working context to answer the
   user's question.

For the runner example, the agent should search terms such as:

- `runner`
- `runnerName`
- `runme.dev/runnerName`
- `configure runner`
- `AppKernel`

and inspect the matching docs/source before answering.

The explicit v0 posture is:

- expose low-level OPFS and network primitives,
- let the agent author the crawl/cache/search code it needs,
- defer higher-level SDK functions until later.

We should be explicit about why we are deferring higher-level SDKs: the desired
end state is that the AI learns the patterns it needs, retains reusable code via
memories or snippets, and only later graduates the most stable patterns into
host-owned abstractions.

### Initial Corpus and OPFS Layout

For v0, the initial unattended corpus should be the public `runmedev/web`
repository at `main`.

We should assume the agent caches repos in OPFS under a layout like:

```text
/code/runmedev/web/
```

That directory should contain a repo-like mirror of fetched files, for example:

```text
/code/runmedev/web/docs/...
/code/runmedev/web/docs-dev/...
/code/runmedev/web/app/src/...
```

Recommended include scope:

- `docs/**`
- `docs-dev/**`
- `app/src/**`
- `packages/**`
- top-level text files such as `README*`, `AGENTS.md`, `package.json`,
  `pnpm-lock.yaml`

Recommended excludes:

- `node_modules/**`
- generated protobuf output where not useful for product questions
- binary assets, large media, and build output

This keeps the first corpus aligned with likely user questions while keeping
search and sync cost bounded.

### Low-Level APIs in AppKernel

The low-level AppKernel/browser substrate for this design should be:

1. a subset of OPFS
2. a network read API, either raw `fetch` or a thin `GET`-oriented wrapper

Representative API shape:

```ts
type OpfsApi = {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<Array<{ name: string; kind: "file" | "directory" }>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ kind: "file" | "directory"; size?: number; mtime?: string }>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
};

type NetworkApi = {
  get(url: string, options?: {
    headers?: Record<string, string>;
    responseType?: "text" | "bytes" | "json";
  }): Promise<{
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    text?: string;
    bytes?: Uint8Array;
    json?: unknown;
  }>;
};
```

This `OpfsApi` is intentionally **not** the native browser OPFS API. Native
OPFS is handle-based:

- `navigator.storage.getDirectory()`
- `FileSystemDirectoryHandle.getDirectoryHandle(...)`
- `FileSystemDirectoryHandle.getFileHandle(...)`
- `FileSystemFileHandle.getFile()`
- `FileSystemFileHandle.createWritable()`

It does not provide direct path-based helpers such as `exists(path)`,
`readText(path)`, or `mkdir(path, { recursive: true })`. Those are convenience
operations we would implement on top of the native handle API.

If raw `fetch` is easier to wire than a thin `get(...)` wrapper, raw `fetch` is
acceptable. The more important point is that the API is policy-governed and
available inside AppKernel code mode.

For v0, these APIs should be enough. We do not need a hand-crafted cache/search
SDK before the agent can operate.

We should implement this path-based API in both:

- the Sandbox Kernel
- the browser-mode kernel

so that the same AppKernel JavaScript can run in either mode without branching
on the storage implementation.

### Policy

For v0, we should keep policy simple:

- all OPFS operations are assumed safe for the AI agent
- all HTTP `GET` requests are assumed safe

That is enough to support the initial crawl/cache/search workflow without
introducing a more complicated policy system up front.

In the future, we can define and enforce a richer policy mechanism covering
things such as:

- allowed HTTP methods
- allowed URI prefixes/domains
- response size, timeout, and content-type limits
- writable OPFS namespaces
- operations that require approval

For now, this proposal assumes the low-level substrate is broadly available and
that stricter enforcement is a follow-on design.

### GitHub Fetch Flow

The transport primitive can be plain HTTP `GET`, but raw blob `GET` alone is
not enough to recurse a repository. To crawl a repo, the agent also needs a
tree or manifest endpoint that it can fetch over `GET`.

For GitHub public repos, the preferred enumeration endpoint is:

```text
GET https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1
```

Example:

```text
GET https://api.github.com/repos/runmedev/web/git/trees/main?recursive=1
```

Important behavior:

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

In this case, the canonical repo-relative file path is:

```text
docs/design/20260331_remove_chatkit_responses_runme_converter.md
```

The agent should use that `path` when writing the file into OPFS:

```text
/code/runmedev/web/docs/design/20260331_remove_chatkit_responses_runme_converter.md
```

For content fetches, prefer raw GitHub URLs built from repo, ref, and path:

```text
https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
```

Example:

```text
https://raw.githubusercontent.com/runmedev/web/main/docs/design/20260331_remove_chatkit_responses_runme_converter.md
```

The `url` field in the tree response is a Git object API URL, not the preferred
file-content URL for this design.

### Ripgrep-Style Search Workflow

The intended search behavior is lexical and file-oriented, closer to `ripgrep`
than to vector retrieval.

In practice, the agent should:

1. recursively walk files under `/code/runmedev/web/`,
2. filter by path patterns if useful,
3. read file contents,
4. apply JavaScript lexical matching using `RegExp`, substring matching, or
   other JS/TS libraries when needed,
5. collect file path + snippet + line context,
6. use that material as context for the final answer.

This is fundamentally a search over individual files. It is not a requirement
that v0 build a formal full-text index first.

For the expected corpus size, simple recursive scanning over cached files is a
reasonable starting point. If latency later becomes a problem, we can add an
incremental index over the same OPFS-backed corpus.

### Browser Storage Design

OPFS should hold the agent-managed repo mirror and derived artifacts. IndexedDB
via Dexie can still be useful for metadata, manifests, and future indexes, but
the primary mental model for v0 should be "the agent is writing a repo mirror
under `/code/...` in OPFS".

Suggested layout:

```text
/code/runmedev/web/...
/derived/runmedev/web/...
/memories/...
```

At the browser level, OPFS is reached through:

- `navigator.storage.getDirectory()`

which returns a `FileSystemDirectoryHandle` for the origin-private root. The
underlying platform APIs include `getDirectoryHandle(...)`,
`getFileHandle(...)`, directory iteration, `removeEntry(...)`,
`createWritable()`, and `createSyncAccessHandle()` in dedicated workers.

The sandbox kernel does not need to expose those browser objects directly. It
can expose a simpler RPC-style OPFS API over `postMessage` that maps onto them.

We should use the same path-based wrapper contract in both sandbox and
browser-mode kernels. That way agent-authored code can say
`await opfs.readText("/code/runmedev/web/README.md")` regardless of whether the
current AppKernel execution is running in the sandbox iframe or the direct
browser JS kernel.

### Requirements for the Codex WASM Harness

To make this proposal work, the `codex-wasm` harness needs to provide more than
just a generic code executor.

Required v0 capabilities:

1. System prompt injection  
   The browser harness must provide explicit system/developer instructions
   describing:
   - that code runs inside AppKernel,
   - that OPFS and network APIs are available,
   - the approved OPFS path layout,
   - the approved GitHub URL prefixes,
   - the expectation that the agent should fetch/cache/search source itself.

   This is necessary because the wasm build currently does not read project docs
   from `AGENTS.md` on its own.

2. Low-level bridge APIs in code mode  
   AppKernel code mode must expose the OPFS/network primitives described above.

3. Stable code-mode output semantics  
   The agent needs predictable tool output. Today the browser executor returns
   one merged `output` string, and Codex wraps that in a status header. That is
   workable for v0, but the harness should preserve that behavior explicitly so
   agent-authored retrieval code can rely on printed snippets showing up in tool
   output.

4. Sufficient code payload/runtime limits  
   The harness needs enough code size, output size, and timeout budget for
   crawl/search tasks. The current defaults in Runme are oriented toward short
   snippets and may need adjustment as soon as the agent starts walking repos.

5. Reusable per-turn or cross-turn state  
   The current WASM bridge already supports `stored_values` in the code-mode
   runtime contract. We should preserve or extend that path so the agent can
   retain helper functions and small bits of state across executions.

6. Memory integration  
   If the product direction is "let the AI evolve the SDK it needs", then the
   harness needs a memory mechanism that lets the agent retain successful
   crawl/cache/search code snippets and reuse them later.

### System Prompt Shape

The harness prompt should tell Codex three things clearly:

1. what low-level capabilities exist,
2. what policy boundaries apply,
3. what repo layout and retrieval workflow are expected.

Recommended system prompt addition:

```text
You are operating inside the Runme app ChatKit panel in a browser.
Executed JavaScript runs in AppKernel. Inside AppKernel you have access to
policy-approved browser storage and network APIs.

Use OPFS as a local repo cache under /code/${ORG}/${REPO}. For Runme source
questions, prefer caching runmedev/web under /code/runmedev/web.

If /code/runmedev/web is missing or stale, fetch the GitHub tree manifest from
https://api.github.com/repos/runmedev/web/ and fetch file contents from
https://raw.githubusercontent.com/runmedev/web/. Persist fetched files in OPFS,
then search them lexically with JavaScript before answering.

For now, assume HTTP GET and OPFS operations are available without approval.
Preserve path and revision metadata when you report findings.
```

### Why We Are Deferring Higher-Level SDKs

We should be explicit that v0 is intentionally not defining a bespoke search
SDK.

The reason is not that higher-level SDKs are always bad. The reason is that the
desired product behavior is:

- expose minimal primitives first,
- let the agent discover which retrieval patterns actually matter,
- preserve those patterns via memory/snippets,
- standardize only the patterns that prove stable and broadly useful.

That is a better fit for the "agentic search" goal than freezing a host-owned
API surface too early.

### V0 Implementation Sketch

1. Add sandbox-kernel RPCs for policy-governed OPFS operations.
2. Add sandbox-kernel RPCs for policy-governed network reads (`fetch` or
   `get`).
3. Request persistent browser storage when available.
4. Update the `codex-wasm` prompt prefix so it describes:
   - AppKernel runtime,
   - OPFS path layout,
   - the availability of OPFS operations and HTTP `GET`,
   - the expected fetch/cache/search workflow.
5. Ensure AppKernel code mode has enough timeout/output budget for crawl/search
   snippets.
6. Add or plan a memory path so the agent can retain successful crawl/cache/search
   snippets across sessions.

## Open Questions

- Should the network API be raw `fetch`, or do we want a slightly narrower
  `get(...)` helper?
- Do we want to reserve a second OPFS namespace for derived artifacts such as
  line indexes or cached match results?
- How much output budget is needed before crawl/search snippets become usable in
  practice?
- What memory mechanism should Codex/browser use to preserve reusable
  crawl/cache/search snippets across sessions?
- At what point should agent-evolved patterns graduate into first-class SDKs or
  tools owned by the host runtime?

## References

- [20260403 Drive Agentic Search](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260403_drive_agentic_search.md)
- [20260414 Codex WASM Harness](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260414_codex_wasm.md)
- [20260331 Code Mode](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260331_code_mode.md)
