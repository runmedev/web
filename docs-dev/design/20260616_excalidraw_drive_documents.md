# Excalidraw Drive Documents

## Status

Draft PR implementation.

## Summary

Add Excalidraw diagrams as first-class workspace documents backed by Google
Drive JSON files.

The app stores each diagram as a normal Drive file with an Excalidraw JSON
payload. The workspace explorer creates and opens `.excalidraw` files from
Drive folders. The main document tab system renders those files with the
embedded `@excalidraw/excalidraw` editor and autosaves scene updates back to
Drive.

This is intentionally not a new storage backend. It extends the existing Drive
store with generic text content helpers and reuses workspace document tabs for
non-notebook content.

## Motivation

Runme notebooks often need lightweight diagrams next to runnable docs. Users
already organize notebooks in Google Drive, so diagrams should live in the same
Drive folders and open from the same workspace explorer.

The shortest useful path is:

- create a `.excalidraw` file in a mounted Drive folder,
- open it as a document tab,
- edit with Excalidraw,
- save the Excalidraw scene JSON back to the same Drive file.

## Goals

- Create Excalidraw diagrams in Google Drive folders.
- Show existing `.excalidraw` and `.excalidraw.json` files in Drive-backed
  workspace explorer folders.
- Open Excalidraw diagrams as workspace document tabs.
- Autosave editor changes to the backing Drive file.
- Restore open Excalidraw tabs across session reloads.
- Verify the editor and Drive-save interface in the in-app browser.

## Non-Goals

- Add local filesystem or IndexedDB Excalidraw storage.
- Convert Excalidraw diagrams into notebook cells.
- Add collaborative editing, Drive revisions UI, or conflict resolution for
  Excalidraw files.
- Export diagrams as PNG, SVG, or Markdown embeds.
- Build a server-side Excalidraw backend.

## User Flow

1. The user mounts or opens a Google Drive folder in the workspace explorer.
2. The user right-clicks the folder and selects `New Excalidraw Diagram`.
3. The app creates a local mirror row immediately with
   `untitled-YYYYMMDD-HHMM.excalidraw`.
4. The row enters rename mode, matching regular notebook creation.
5. The local store asynchronously creates the backing Drive file and updates the
   local row with its Drive URI.
6. The user opens the diagram and edits in Excalidraw.
7. The editor serializes the scene and writes it back to the Drive file after a
   short debounce.

Existing files follow the same open path. A Drive file named `.excalidraw` or
`.excalidraw.json` appears in the explorer and opens in the Excalidraw editor.

## Data Model

The Drive file body is Excalidraw's JSON scene format:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "runme",
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

The file MIME type is:

```text
application/vnd.excalidraw+json
```

The workspace document URI remains the local document URI:

```text
local://file/<uuid>
```

The local record stores the backing Drive URI in `remoteId`, exposed to the tab
as `requestedUri`. The local record and workspace document also carry the MIME
type. The renderer uses `application/vnd.excalidraw+json` to select
Excalidraw.

We do not introduce an `excalidraw://` URI scheme. A URI identifies the stored
document, not the renderer. The MIME type and filename fallback control how the
document is rendered.

## Architecture

### Drive Store

`DriveNotebookStore` gains generic content methods:

```ts
createContent(
  parentUri: string,
  name: string,
  content: string,
  mimeType?: string,
): Promise<NotebookStoreItem>

loadContent(uri: string): Promise<string>
```

The existing `saveContent(uri, content, mimeType)` method already supports
updating arbitrary Drive file bytes. Excalidraw uses these methods:

- `createContent` creates the initial `.excalidraw` file when local pending
  sync completes.
- `loadContent` reads the current scene JSON.
- `saveContent` writes serialized scene JSON after edits.

These helpers do not make `DriveNotebookStore` Excalidraw-specific. They are
generic text-content operations for Drive files.

### Local Store Metadata

`LocalFileRecord` gains an optional `mimeType`:

```ts
interface LocalFileRecord {
  id: string
  name: string
  mimeType?: string
  remoteId: string
  // ...
}
```

`NotebookStoreItem` also gains `mimeType?: string` so Drive listing metadata can
flow through the local mirror to the workspace explorer and document tabs.

For new files in Drive-backed folders, `LocalNotebooks.createContent(...)`
creates the local row first, stores the initial content and MIME type, and lets
the existing pending-create sync path create the upstream Drive file. For
existing Drive-backed files, `LocalNotebooks.addFile(...)` stores the Drive file
MIME type and returns the stable `local://file/<uuid>` URI. For old records or
Drive files that do not report the custom MIME type, `.excalidraw` and
`.excalidraw.json` remain a fallback.

### Excalidraw Storage Helpers

`app/src/storage/excalidraw.ts` owns Excalidraw-specific constants and
metadata helpers:

- `EXCALIDRAW_MIME_TYPE`
- `isExcalidrawFileName(name)`
- `isExcalidrawMimeType(mimeType)`
- `isExcalidrawDocumentMetadata(item)`
- `createInitialExcalidrawDocumentJson()`

This keeps filename and MIME detection out of React components.

### Workspace Explorer

The explorer treats `.json` notebooks and Excalidraw diagrams as visible Drive
document files. For Excalidraw files:

- opening the file creates a workspace document tab,
- the document URI is the local mirror URI,
- the document title uses the Drive file name,
- the requested URI remains the backing Drive file URI,
- the MIME type is `application/vnd.excalidraw+json`.

The context menu creates new diagrams only for Drive folders. Local notebook
folders are excluded because this implementation does not add local
Excalidraw storage.

### Workspace Documents

Workspace document restore persists `uri`, `title`, `requestedUri`, and
`mimeType` for local document tabs. This lets a Drive-backed Excalidraw tab
survive reloads in the same browser session while keeping the tab URI as
`local://file/<uuid>`.

Notebook runtime helpers should still treat only notebook URIs as notebooks.
Because Excalidraw also uses `local://file/<uuid>`, `Actions.tsx` checks the
MIME type before falling back to the notebook renderer.

### AppKernel Content API

WebMCP needs a storage-level content API that works for notebooks and
non-notebook documents. The API should operate on document URIs, not Drive file
ids, so callers can use the same URI the app shows in tabs and explorer rows.

The AppKernel should expose two methods:

```ts
type DocumentContent = {
  uri: string
  requestedUri?: string
  name: string
  mimeType?: string
  content: string
  syncStatus?: NotebookSyncStatus
  version?: {
    checksum?: string
    revisionId?: string
    modifiedTime?: string
  }
}

type DocumentUpdateResult = {
  uri: string
  requestedUri?: string
  name: string
  mimeType?: string
  syncStatus?: NotebookSyncStatus
  version?: {
    checksum?: string
    revisionId?: string
    modifiedTime?: string
  }
}

interface DocumentContentApi {
  get(uri: string): Promise<DocumentContent>
  update(
    uri: string,
    content: string,
    options?: {
      mimeType?: string
      expectedVersion?: string
      flush?: boolean
    },
  ): Promise<DocumentUpdateResult>
}
```

`get(uri)` resolves the URI through the local mirror first. For
`local://file/<uuid>`, it returns the IndexedDB content. If the local content is
empty and the record has a Drive `remoteId`, it may hydrate the local mirror
from Drive before returning. For a Drive URI, the API should first attach or
find the local mirror row, then return the local URI and content.

`update(uri, content, options)` writes through the local mirror first. It should
update IndexedDB immediately, preserve the document MIME type, notify any open
tabs, and enqueue normal Drive sync. When `options.flush` is true, it should
also wait for the backing store sync attempt and return the resulting sync
state. This matches notebook editing: local state is the interactive source of
truth, and Drive is the upstream synchronization target.

The API should support these MIME types without special WebMCP code paths:

- `application/json` for notebook JSON,
- `application/vnd.excalidraw+json` for Excalidraw scenes,
- future text-like document MIME types.

Notebook-specific APIs can remain for semantic notebook operations, such as
adding cells or running code. `get` and `update` are raw document-content
operations. They should not parse Excalidraw as a notebook, and they should not
require callers to know whether a document is currently local-only,
pending-Drive-create, or Drive-backed.

Example WebMCP usage:

```js
const doc = await documents.get("local://file/63b0...")
const scene = JSON.parse(doc.content)
scene.elements.push({
  id: crypto.randomUUID(),
  type: "text",
  x: 120,
  y: 80,
  width: 80,
  height: 25,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: Date.now(),
  version: 1,
  versionNonce: Date.now(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  text: "Box A",
  fontSize: 20,
  fontFamily: 5,
  textAlign: "left",
  verticalAlign: "top",
  containerId: null,
  originalText: "Box A",
  lineHeight: 1.25,
})

await documents.update(doc.uri, JSON.stringify(scene, null, 2), {
  mimeType: "application/vnd.excalidraw+json",
  flush: true,
})
```

The first implementation can expose this as `documents.get` and
`documents.update` in App Console and WebMCP. The backing implementation should
delegate to `LocalNotebooks.getContent/updateContent` for local URIs and to the
Drive attach flow for Drive URIs. The names should stay document-oriented
rather than Drive-oriented because the URI, not the storage provider, selects
the backing path.

### Editor Component

`ExcalidrawDocument` loads the backing Drive JSON, restores it through
Excalidraw's `restore` helper, and renders the editor.

On every editor change:

1. The component serializes the scene with `serializeAsJSON`.
2. It compares the serialized scene with the last saved scene.
3. If the scene changed, it schedules a debounced save.
4. The save writes the JSON to Drive with `EXCALIDRAW_MIME_TYPE`.
5. The header shows `Ready`, `Saving...`, or `Saved to Drive`.

Loaded scenes are normalized through Excalidraw serialization before dirty
comparison. This avoids treating formatting differences in the loaded JSON as
user edits.

### Development Verification

Development verification should use the existing Google Drive service-account
auth path with a test/development service account. That keeps the test path on
the production Drive store, folder mirroring, MIME metadata, and autosave code.

The PR does not add an Excalidraw-specific in-app browser harness. A fake Drive
store would verify less of the storage design than the service-account path.

## Licensing

The embedded package is `@excalidraw/excalidraw@0.18.1`. Its package metadata
declares the license as `MIT`.

This license does not block embedding the editor in the Runme web app. The PR
does not copy Excalidraw source into the repository; it consumes the published
npm package through the existing dependency workflow.

## Error Handling

The editor shows a centered error state when:

- the Drive store is not initialized,
- the backing Drive file cannot be loaded,
- the scene JSON is invalid,
- or Drive save fails.

Save failures replace the editor with an error state in this draft. That is
simple and visible, but it is not the best long-term user experience. A later
iteration should keep the editor mounted, show a persistent error banner, and
allow retry without losing unsaved local scene state.

## Risks And Tradeoffs

### No Conflict Resolution

Excalidraw files currently autosave directly to Drive. If two browser sessions
edit the same file, the last writer wins. This matches the first implementation
scope but is weaker than notebook conflict handling.

### Browser Bundle Size

Embedding Excalidraw adds a large editor dependency to the app bundle. The
draft implementation imports the editor directly in the document component.
Lazy-loading the Excalidraw document renderer is a reasonable follow-up if
bundle size becomes a release concern.

### Drive-Only Creation

Creation is limited to Drive folders. That keeps the storage model small and
matches the requested use case, but it means local workspaces cannot create
diagrams yet.

## Verification

Automated checks:

```bash
pnpm -C app exec vitest run \
  src/storage/excalidraw.test.ts \
  src/storage/drive.test.ts \
  src/lib/workspaceDocuments/workspaceDocumentController.test.ts

runme run build test
```

Manual Drive verification:

1. Configure Google Drive auth with the test/development service account.
2. Mount a Drive folder.
3. Right-click the folder and select `New Excalidraw Diagram`.
4. Draw in the opened editor.
5. Reload and reopen the `.excalidraw` file.
6. Confirm the scene is restored from Drive.

## Follow-Ups

- Keep the editor mounted when saves fail and add retry UI.
- Lazy-load the Excalidraw editor bundle.
- Add Drive revision or conflict indicators for diagram files.
- Add export actions for PNG/SVG.
- Support local filesystem-backed Excalidraw files.
