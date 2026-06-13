# Notebook Comments

Date: 2026-06-11

Builds on:

- `docs-dev/design/20260409_refactor_notebooks.md`
- `docs-dev/design/20260520_notebook_session_refactor.md`
- `docs-dev/design/20260522_notebook_diffs.md`

## Summary

Add cell-level comment threads to Google Drive-backed notebooks.

V0 should use the Google Drive Comments API as the canonical comment store.
Comments should be enabled only when the current notebook has a Google Drive
upstream file. Local-only and filesystem-backed notebooks should show comments
as unavailable until they are saved to Drive.

Each Drive comment should anchor to a Runme cell id using an app-defined Drive
comment anchor. Replies, resolution state, author identity, and edit/delete
permissions should come from Drive. Runme should keep only transient UI state
and optional local caches, not full comment threads inside the notebook file.

This trades portable `.ipynb` comments for Google-native collaboration. That is
the right V0 tradeoff because sharing and commenting are primarily Drive
workflows in Runme. The Google Workspace Events API also gives us a path to
comment/reply notifications, external automation, and agent triggers without
polling notebook files.

## Goals

- Let users add comments to cells in Google Drive-backed notebooks.
- Show open and resolved Drive comment threads in a notebook sidebar.
- Show per-cell comment affordances in the notebook body.
- Support replies and resolve/reopen actions through Drive.
- Use Google identity, permissions, authorship, and timestamps for comments.
- Disable comment creation for non-Drive notebooks with a clear save-to-Drive
  path.
- Subscribe to Drive comment and reply events for agent and notification
  workflows when backend infrastructure is available.
- Emit structured events when a comment mentions an agent, such as
  `@codex run this cell`.

## Non-Goals

- Comments on local-only or filesystem-backed notebooks in V0.
- Text-range comments inside a cell in V0.
- Portable `.ipynb` comments in V0.
- Multiplayer live cursors or live collaborative editing.
- A separate Runme permissions model for comments.
- Suggested edits.
- Emoji reactions.
- Offline comment creation.

## Prior Art

### Google Docs

Google Docs treats comments as discussions anchored to selected content. The
core user actions are add, edit, reply, filter, delete, resolve, and reopen.
Users can show all comments in a right-side panel, minimize comments to margin
icons, expand comments inline, search comments, and jump from a comment to its
document location.

Docs also uses mentions and action items. A user can type `@` plus a person or
email in a comment to notify them. Work and school accounts can assign action
items from comments, and closed comments remain accessible.

Sources:

- <https://support.google.com/docs/answer/65129?hl=en>

Design implications:

- Comments need both local anchors and a global panel.
- Resolved comments should remain available.
- Mentions should be parsed from comment text and treated as actionable
  structured data, not only display text.
- V0 should use Google identity rather than inventing a parallel author model.

### Google Drive Comments API

The Drive API has first-class comments and replies on files. It distinguishes
anchored comments from unanchored comments. Anchors are stored as app-defined
JSON strings. Replies are attached to a comment. A comment is resolved by
posting a reply with an action, and the comment resource then exposes
`resolved: true`.

The API returns author, timestamps, deleted/resolved state, plain text content,
HTML content for display, quoted file content, mentioned email addresses, and
assignee email address. Some fields, including mentioned email addresses and
assignee email address, are output-only.

Sources:

- <https://developers.google.com/workspace/drive/api/guides/manage-comments>
- <https://developers.google.com/workspace/drive/api/reference/rest/v3/comments>

Design implications:

- Use Drive comments as the V0 source of truth for Drive-backed notebooks.
- Store the Runme cell anchor in the Drive `anchor` JSON string.
- Treat Drive's author, timestamp, reply, resolved, deleted, and permission
  behavior as canonical.
- Test whether API-created `@email` comments trigger Google-native mention
  notifications before relying on them for product-critical alerts.
- Do not depend on Google Workspace editors to render Runme anchors. Google
  documents that Workspace editor apps treat custom anchored comments as
  unanchored.

### Google Workspace Events API

Google Workspace Events supports Drive comment and reply events. Apps can
subscribe to Drive files or shared drives and receive events through Cloud
Pub/Sub. Supported Drive event types include comment created, edited, resolved,
reopened, deleted, and reply created, edited, and deleted.

Sources:

- <https://developers.google.com/workspace/events/guides/events-drive>
- <https://developers.google.com/workspace/drive/api/guides/events-overview>

Design implications:

- Drive comments unlock server-side notification and automation workflows.
- Agent triggers should use Workspace Events when a backend subscription is
  available.
- Browser-only V0 can still dispatch local events for comments created in the
  current tab, but cross-user triggers require Workspace Events or polling.
- Subscription lifecycle, Pub/Sub setup, OAuth scopes, and renewal handling are
  backend work, not React component work.

### Google Colab

Colab is built on Jupyter notebooks and stores notebooks in Google Drive.
Colab's FAQ states that Colab notebooks can be shared like Google Docs or
Sheets, that shared notebooks include text, code, output, and comments, and
that Colab notebooks are stored in the open source Jupyter `.ipynb` format.

Sources:

- <https://research.google.com/colaboratory/faq.html>

Design implications:

- Colab is strong product prior art for Drive-first notebook comments.
- Colab is not public implementation prior art for a reusable comments schema.
- Runme can make the same product choice: comments are part of the Drive
  collaboration surface, not necessarily portable notebook content.

### Jupyter `.ipynb`

The official notebook format has top-level `metadata`, `nbformat`,
`nbformat_minor`, and `cells`. Since nbformat 4.5, all cells have an `id`
field. The id must be unique within the notebook and is intended for stable
cell identity; uniqueness across notebooks is explicitly not a goal.

Jupyter metadata is the extension point. The format docs say metadata can hold
arbitrary JSON-able information about a notebook, cell, or output, and custom
metadata should use a unique namespace. The v4.5 schema allows additional
properties inside root-level metadata.

There is no official comments or annotations field in the `.ipynb` format. The
defined cell metadata keys cover rendering and execution concerns such as
collapsed output, tags, `jupyter.source_hidden`, and execution timestamps.

Sources:

- <https://nbformat.readthedocs.io/en/latest/format_description.html>
- <https://jupyter.org/enhancement-proposals/62-cell-id/cell-id.html>
- <https://github.com/jupyter/nbformat/blob/main/nbformat/v4/nbformat.v4.5.schema.json>

Design implications:

- `.ipynb` does not force a comments storage decision.
- Use stable cell ids for Drive comment anchors.
- Do not add a new top-level `.ipynb` field or new cell field for V0 comments.
- If portable comments become a requirement later, use namespaced metadata as an
  export/cache format.

## Current Runme Context

The app-facing persistence path is local-first:

```text
NotebookData / editor tabs
  -> local://file/<id>
  -> LocalNotebooks / IndexedDB
  -> optional upstream from LocalFileRecord.remoteId
```

Drive-backed editor tabs still use a local mirror. The local record points to
the upstream Drive file through `remoteId` / `remoteUri`.

`NotebookData` owns one in-memory `parser_pb.Notebook`. React views render
immutable snapshots. Cells already have stable `refId` values and `metadata`.
The AppKernel notebook API exposes notebook handles, revisions, cells,
metadata, and cell execution helpers. Codex tools already use explicit cell ids
when reading, updating, and executing cells.

## Storage Decision

Use Google Drive Comments API as the canonical V0 comment store.

Comments are available only when:

- the open notebook resolves to a local mirror,
- that local mirror has a Google Drive upstream file id,
- the current user has Drive permission to comment on the file.

For non-Drive notebooks:

- hide or disable add-comment controls,
- show an explanatory disabled state,
- offer "Save to Google Drive to enable comments" when the notebook can be
  copied to Drive.

Do not store full comment threads inside notebook metadata for V0.

Do not store comments in an auxiliary Runme sidecar file for V0.

Do not add a new field to cells for V0.

### Why Drive Comments

Drive comments match the product surface we care about first:

- shared Drive notebooks,
- Google identity,
- Google permissions,
- Google-authored timestamps and edit/delete ownership,
- native replies and resolved state,
- possible Google-native mention notifications,
- Workspace Events for comment/reply automation,
- no extra Runme sync format for comments.

The tradeoff is that comments are not portable notebook content. A user who
downloads an `.ipynb` or copies a notebook into a non-Drive backend will not get
the Drive comment threads. That is acceptable for V0 because the commenting
workflow assumes a shared Drive document.

### Why Not Notebook Metadata

Notebook metadata is still the right portable fallback, but it is the wrong V0
source of truth for Drive-first collaboration.

Metadata comments would require Runme to implement authorship, permissions,
notifications, cross-user updates, conflict handling, and deletion semantics.
Drive already owns those concepts for the primary storage backend.

### Why Not A Sidecar File

A sidecar file gives us portability across storage backends, but it creates a
new sharing, permissions, discovery, and sync problem. It also does not give us
Google-native comment notifications or Workspace Events.

Sidecars can be revisited if comments need to work on non-Drive backends.

## Drive Comment Anchor

V0 anchors are cell anchors only.

Store a Runme-specific JSON payload in the Drive comment `anchor` field:

```json
{
  "runme": {
    "version": 1,
    "type": "cell",
    "cellId": "code_85a39e07",
    "cellIdKind": "runme-ref-id"
  }
}
```

For imported `.ipynb`, preserve the Jupyter cell `id` and map it to Runme's
stable cell identity. When a Drive comment anchors to an imported notebook cell,
the anchor should use the same stable id Runme uses to render that cell.

If a cell is deleted, keep the Drive comment. The UI should render it as an
orphaned thread if the anchor no longer resolves.

If a cell is moved, the thread follows the cell id.

If a cell is duplicated, new cells must get new ids. Comments stay attached to
the original cell only.

Google warns that custom anchors are immutable and that their position relative
to document content is not guaranteed across revisions. Runme should therefore
treat the Drive anchor as an immutable cell-id pointer and resolve it against
the current notebook model at render time.

## Proposed Data Model

Use a Runme view model over Drive comments:

```ts
type NotebookCommentThread = {
  driveFileId: string
  driveCommentId: string
  anchor: CommentAnchor
  status: 'open' | 'resolved'
  createdAt: string
  updatedAt: string
  author: DriveCommentAuthor
  htmlContent: string
  content: string
  mentionedEmailAddresses: string[]
  assigneeEmailAddress?: string
  replies: NotebookCommentReply[]
  orphaned: boolean
  agentDispatch?: AgentDispatchState
}

type CommentAnchor = {
  type: 'cell'
  cellId: string
  cellIdKind: 'runme-ref-id' | 'ipynb-cell-id'
}

type NotebookCommentReply = {
  driveReplyId: string
  createdAt: string
  updatedAt: string
  author: DriveCommentAuthor
  htmlContent: string
  content: string
  deleted: boolean
}

type DriveCommentAuthor = {
  displayName: string
  photoLink?: string
  me?: boolean
}

type AgentDispatchState = {
  status: 'pending' | 'sent' | 'acked' | 'failed'
  targetAgent: string
  source: 'local-tab' | 'workspace-events'
  messageId?: string
  lastError?: string
  updatedAt: string
}
```

The view model should be derived from:

- `comments.list` / `comments.get`,
- Drive comment `anchor`,
- Drive comment `resolved` and `deleted`,
- Drive reply lists,
- the current notebook cell index.

Runme may cache this model in memory or IndexedDB for responsiveness. The cache
is not the source of truth.

## UI Proposal

V0 should use a Google Docs-like split between margin affordances and a global
comments panel.

Notebook body:

- Show a comment icon in each cell toolbar or right gutter for Drive-backed
  notebooks.
- Show a disabled icon or omit the affordance for non-Drive notebooks.
- Show an active/open count on the icon.
- Click the icon to open the thread composer for that cell.
- Highlight the active cell when a comment thread is selected.
- Show a compact marker for cells with open comments.

Comments panel:

- Dock the panel on the right side of the notebook.
- Load Drive comments for the current Drive file.
- List Runme-anchored threads first, grouped by notebook order.
- Provide filters for open, resolved, and all.
- Select a thread to scroll the notebook to the anchored cell.
- Support reply, resolve, reopen, edit own comment, and delete own comment
  through Drive API calls.
- Show orphaned Runme-anchored threads in a separate section.
- Optionally show unanchored Drive comments in a document-level section.

Composer:

- Plain text input for V0, matching Drive's `content` field.
- Detect `@codex` mentions locally.
- Preserve email mentions in the text so Drive can detect Google user mentions
  if supported for API-created comments.
- Submit with `Cmd/Ctrl+Enter`.
- Preserve draft text while the user switches cells.

Accessibility:

- All comment controls need labels.
- The active thread needs focus management between the panel and cell.
- Keyboard shortcuts can follow Docs later: next/previous comment, reply,
  resolve, and exit.

## Agent Hook

Drive comments should trigger agents through two paths.

The local path handles comments created in the current browser tab:

```text
user submits comment in Runme
  -> Runme creates Drive comment with Runme cell anchor
  -> Drive returns comment id and normalized resource
  -> Runme emits NotebookDriveCommentCreatedEvent
  -> Mention router sees @codex
  -> router sends Drive file id, comment id, cell id, and cell context
     to the Codex conversation bridge
```

The server path handles comments created by other users or in other tabs:

```text
Workspace Events subscription receives drive.comment.v3.created
  -> event handler fetches the Drive comment if needed
  -> handler parses the Runme cell anchor
  -> handler checks mentions and dispatch state
  -> handler sends Drive file id, comment id, cell id, and notebook context
     to the agent service
```

Proposed local event:

```ts
type NotebookDriveCommentCreatedEvent = {
  type: 'notebook.driveComment.created'
  notebook: {
    uri: string
    name: string
    driveFileId: string
    revision: string
  }
  driveComment: {
    id: string
    anchor: CommentAnchor
    content: string
    htmlContent: string
    mentionedEmailAddresses: string[]
  }
  context: {
    cell?: {
      refId: string
      kind: string
      languageId: string
      value: string
      metadata: Record<string, string>
    }
  }
  mentions: CommentMention[]
}

type CommentMention = {
  raw: string
  kind: 'agent' | 'user'
  target: string
}
```

Agent dispatch must be idempotent. Use `(driveFileId, driveCommentId,
targetAgent)` as the de-duplication key. For server-side event handling, store
dispatch state outside the notebook file, for example in the agent service or a
Runme backend table.

## API Surface

Add a Drive-backed comments service rather than comment methods directly on
`NotebookData`:

```ts
type NotebookCommentsAvailability =
  | { enabled: true; driveFileId: string }
  | { enabled: false; reason: 'not-drive-backed' | 'missing-permission' }

type NotebookCommentsService = {
  getAvailability(target?: NotebookTarget): Promise<NotebookCommentsAvailability>
  listThreads(args: {
    target?: NotebookTarget
    status?: 'open' | 'resolved' | 'all'
  }): Promise<NotebookCommentThread[]>
  createThread(args: {
    target?: NotebookTarget
    cellId: string
    content: string
  }): Promise<NotebookCommentThread>
  reply(args: {
    target?: NotebookTarget
    driveCommentId: string
    content: string
  }): Promise<NotebookCommentThread>
  resolve(args: {
    target?: NotebookTarget
    driveCommentId: string
    content?: string
  }): Promise<NotebookCommentThread>
  reopen(args: {
    target?: NotebookTarget
    driveCommentId: string
  }): Promise<NotebookCommentThread>
}
```

Expose an AppKernel API after the internal service is stable:

```ts
type NotebooksCommentsApi = {
  availability(target?: NotebookTarget): Promise<NotebookCommentsAvailability>
  list(args?: { target?: NotebookTarget; status?: 'open' | 'resolved' | 'all' }): Promise<NotebookCommentThread[]>
  create(args: { target?: NotebookTarget; cellId: string; content: string }): Promise<NotebookCommentThread>
  reply(args: { target?: NotebookTarget; driveCommentId: string; content: string }): Promise<NotebookCommentThread>
  resolve(args: { target?: NotebookTarget; driveCommentId: string; content?: string }): Promise<NotebookCommentThread>
  reopen(args: { target?: NotebookTarget; driveCommentId: string }): Promise<NotebookCommentThread>
}
```

## Sync And Conflict Behavior

Drive comments are separate from notebook content.

Comment-only changes should not dirty the notebook or change the notebook JSON.
They should update the comments panel and any local comment cache. Notebook
content sync and comment sync are separate channels:

```text
Notebook content:
  NotebookData -> LocalNotebooks -> Drive file content

Notebook comments:
  Comments panel -> Drive Comments API -> Workspace Events / local refresh
```

If the notebook content changes and cell ids remain stable, comments continue
to resolve. If a cell id disappears, the comment becomes orphaned in Runme but
remains a valid Drive comment.

Notebook diff views do not need to show comment changes in V0 because comments
are not notebook file content.

## Security And Privacy

Comments are Drive file collaboration data. A user who can access comments on
the Drive file can see them according to Drive permissions. A user who exports
or downloads the notebook file does not automatically export comments.

Agent mentions need explicit product behavior:

- `@codex` should not execute code silently unless the command and current
  product mode allow it.
- The agent payload should include the Drive file id, comment id, anchor cell
  id, and minimal cell context by default.
- Broader notebook context should be requested through existing notebook APIs.
- Comments may contain secrets; agent dispatch should follow the same data-use
  rules as the AI chat panel.
- Workspace Events subscriptions must verify Drive permissions and ignore
  comments whose anchors are not Runme anchors.

## Implementation Plan

1. Add Drive comment read/write helpers for `comments.list`, `comments.create`,
   `comments.update`, `replies.create`, and resolve/reopen behavior.
2. Add Runme anchor parsing and serialization for Drive comment anchors.
3. Add comments availability detection from the current notebook's Drive
   upstream file id and user permissions.
4. Add a lightweight comments panel and per-cell comment icon for Drive-backed
   notebooks.
5. Disable comment controls for non-Drive notebooks and add a save-to-Drive
   entry point.
6. Add mention parsing for `@codex`.
7. Emit local comment-created events for comments created in the current tab.
8. Add AppKernel comments API once the internal Drive comments service settles.
9. Spike Workspace Events subscriptions for Drive comment and reply events,
   including Pub/Sub setup, OAuth scopes, renewal behavior, and event payloads.
10. Decide whether Workspace Events-backed agent dispatch is part of V0 or the
    first follow-up milestone.
11. Test whether Drive API-created comments with `@email` trigger Google-native
    email/web notifications.

## Open Questions

- Should Workspace Events-backed agent dispatch be required for V0, or can V0
  ship with only local-tab dispatch and manual refresh?
- Do API-created comments with `@email` reliably trigger Google-native mention
  notifications?
- Should Runme show unanchored Drive comments, or only Runme-anchored comments?
- Should `@codex run this cell` execute immediately, or should it open a
  confirmation affordance in the thread?
- How should comments behave when a local notebook is later saved to Drive?
- Which OAuth scopes are acceptable for comment read/write and Workspace Events
  subscriptions?
