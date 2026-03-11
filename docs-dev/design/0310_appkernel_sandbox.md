# 0310 AppKernel Sandbox (Tentative)

## Status

This is a **tentative** design proposal under discussion.

## Motivation

We need to improve how Codex accesses and manipulates notebooks.

Today, Codex is strongest when it can write and run short programs, but many
notebook interactions are currently exposed as narrow, individual tool calls.
That pushes workflows into brittle multi-step tool orchestration.

The direction in this doc is:

- let Codex operate on notebooks through executable AppKernel programs,
- keep access safe via a strict sandbox and host-enforced policy,
- avoid giving untrusted cell code direct access to browser/network/app state.

## Problem Statement

Current AppKernel execution runs code in-process via `new Function(...)`, so
cell code shares the main app JS realm:

- [notebookData.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/notebookData.ts)
- [jsKernel.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/jsKernel.ts)

In that model, simple `fetch` interception is not a sufficient defense against
data exfiltration.

## Goals

- Run AppKernel code/input in an isolated browser sandbox.
- Make host communication explicit and policy-enforced.
- Allow selected notebook operations (example: list currently open notebooks).
- Support Google Drive helpers through controlled host capabilities.
- Keep OAuth tokens and sensitive headers out of untrusted code.

## Non-Goals (v0)

- Perfect isolation equivalent to process sandboxing.
- Supporting arbitrary direct network access from AppKernel user code.
- Full capability parity with all existing helpers on day one.

## Isolation Model

### Chosen default: sandboxed iframe

Execute untrusted AppKernel code in an iframe with:

- `sandbox="allow-scripts"`
- **no** `allow-same-origin`

Implications:

- iframe gets an opaque origin (`origin = "null"`),
- no access to app DOM/cookies/localStorage/sessionStorage,
- no direct access to app IndexedDB data,
- all useful app interactions must be brokered by host APIs.

### Why not only Worker

A Worker gives a separate JS global and thread, but same-origin workers can
still use APIs like `indexedDB`, `fetch`, and `WebSocket`. Worker-only does not
give the same origin isolation as a sandboxed opaque-origin iframe.

### Relation to V8 Isolates

This is similar in spirit (separate execution context), but not equivalent to a
true V8 isolate/process boundary.

## Communication Model

Use a brokered RPC protocol over `postMessage` + `MessageChannel`.

1. Host creates iframe and `MessageChannel`.
2. Host sends an `init` message with one channel port and a per-session token.
3. Sandbox exposes a small API shim that forwards RPC requests to host.
4. Host validates method, args, policy, and returns result/error.

Security checks:

- validate `MessagePort` ownership,
- require session token/capability token on every request,
- strict schema validation for each method,
- default deny for unknown methods.

## Capability API ("System Calls")

Define a small syscall-like surface; higher-level helpers are built on top.

### 1) `notebook.*`

Host-owned notebook state operations, for example:

- `notebook.listOpen()`
- `notebook.getCell(refId)`
- `notebook.updateCell(refId, patch)`

### 2) `net.request`

Restricted host-mediated network primitive for untrusted code.

Default v0 policy:

- allow only `GET` and `HEAD`,
- deny sensitive headers (`authorization`, `cookie`, `proxy-authorization`,
  `x-api-key`, case-insensitive),
- optional host allowlist,
- force `credentials: "omit"` and `referrerPolicy: "no-referrer"`.

### 3) `storage.kv.*`

Host-backed storage namespace APIs (not direct browser storage access):

- `storage.kv.get(scope, key)`
- `storage.kv.set(scope, key, value)`
- `storage.kv.delete(scope, key)`
- `storage.kv.list(scope, prefix?)`

Backed by LocalStorage/IndexedDB in host, namespaced per notebook/project.

### 4) `drive.*` (privileged domain)

Drive operations are explicit host capabilities, not raw network from sandbox:

- `drive.list(folder)`
- `drive.create(folder, name)`
- `drive.update(id, bytes)`
- `drive.saveAsCurrentNotebook(folder, name)`

Rationale: Drive write paths require authenticated `POST/PATCH`. A global
`net.request` policy of "GET-only" should remain strict for untrusted raw HTTP,
while `drive.*` follows separate capability rules.

## Policy Model

Separate policy domains:

- Raw network policy (`net.request`): very restrictive.
- Capability policy (`notebook.*`, `drive.*`, `storage.*`): explicit allowlist.

Policy evaluation order:

1. Method allowlist check
2. Arg/schema validation
3. Per-method policy checks (host, path, size, rate, user approval)
4. Execution in host adapter
5. Structured result/error to sandbox

## Example: List Open Notebooks

Sandbox calls:

- `notebook.listOpen()`

Host handler returns sanitized notebook summaries only (for example uri/name),
not raw internal state by default.

## Google Drive & Exfiltration

Current Drive helpers route through host modules:

- [appJsGlobals.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/appJsGlobals.ts)
- [driveTransfer.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/driveTransfer.ts)
- [drive.ts](/Users/jlewi/code/runmecodex/web/app/src/storage/drive.ts)

In the sandbox model:

- OAuth tokens stay host-side only,
- sandbox code never receives bearer tokens,
- caller-provided headers are not accepted for `drive.*`,
- all Drive writes go through capability checks.

## Implementation Outline

1. Add sandbox runtime host (`appKernelSandboxHost.ts`) with RPC broker.
2. Add sandbox bootstrap script (`appKernelSandboxClient.ts`) exposing syscall shims.
3. Route AppKernel execution in `NotebookData` through sandbox host instead of direct `new Function(...)`.
4. Port existing helper namespaces (`app`, `runme`, `drive`, etc.) onto brokered capability calls.
5. Add policy tests for:
   - denied POST in `net.request`,
   - denied sensitive headers,
   - allowed `notebook.listOpen`,
   - Drive capability gating.

## Open Questions

- Which notebook methods are included in v0 (`read-only` first vs `read/write`)?
- Do any `drive.*` write methods require explicit per-call user approval?
- Should `storage.kv` be notebook-scoped only in v0?
- Do we need per-cell capability manifests in metadata?

