# Notebook Comments

Date: 2026-06-11

Builds on:

- `docs-dev/design/20260409_refactor_notebooks.md`
- `docs-dev/design/20260520_notebook_session_refactor.md`
- `docs-dev/design/20260522_notebook_diffs.md`

## Summary

Add cell-level comment threads to notebooks.

V0 should store comments inside the notebook document, under notebook metadata,
not in an auxiliary file and not as a new cell field. Each thread should anchor
to a stable cell id. Replies, resolution state, author metadata, and agent
dispatch state should live with the thread.

This gives Runme a Google Docs/Colab-like review surface while preserving
Jupyter `.ipynb` compatibility. Jupyter's notebook format does not define a
standard comments or annotations model. It does define stable cell ids and
allows arbitrary JSON metadata at the notebook, cell, and output levels. Those
two facts are the compatibility path.

## Goals

- Let users add comments to notebook cells.
- Show open and resolved comment threads in a notebook sidebar.
- Show per-cell comment affordances in the notebook body.
- Support replies and resolve/reopen actions.
- Persist comments with local, Drive-backed, and filesystem-backed notebooks.
- Preserve comments when a Drive-backed notebook is shared or copied.
- Preserve `.ipynb` compatibility for native notebook support.
- Emit structured events when a comment mentions an agent, such as
  `@codex run this cell`.

## Non-Goals

- Text-range comments inside a cell in V0.
- Multiplayer live cursors or live collaborative editing.
- Google Drive Comments API parity in V0.
- A separate permissions model for comments.
- Suggested edits.
- Emoji reactions.
- Email notifications.

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
- V0 can skip assignment and notifications while keeping room in the model for
  them.

### Google Drive Comments API

The Drive API has first-class comments and replies on files. It distinguishes
anchored comments from unanchored comments. Anchors are stored as app-defined
JSON strings. Replies are attached to a comment. A comment is resolved by
posting a reply with an action, and the comment resource then exposes
`resolved: true`.

Drive's anchor model is useful, but it is not a drop-in storage backend for
Runme V0. Google Workspace editor apps treat custom anchored comments as
unanchored, and Drive warns that anchors are immutable and their position across
document revisions is not guaranteed.

Sources:

- <https://developers.google.com/workspace/drive/api/guides/manage-comments>
- <https://developers.google.com/workspace/drive/api/reference/rest/v3/comments>

Design implications:

- Model comments as threads with replies and resolved state.
- Keep anchors immutable after thread creation.
- Use cell ids rather than line offsets for V0 anchors.
- Consider Drive comments later for Drive-backed sharing, but do not make them
  the canonical V0 store.

### Google Colab

Colab is built on Jupyter notebooks and stores notebooks in Google Drive.
Colab's FAQ states that Colab notebooks can be shared like Google Docs or
Sheets, that shared notebooks include text, code, output, and comments, and
that Colab notebooks are stored in the open source Jupyter `.ipynb` format.

Sources:

- <https://research.google.com/colaboratory/faq.html>

Design implications:

- Colab is strong product prior art for comments as notebook content.
- Colab is not public implementation prior art for a reusable comments schema.
- The most compatible interpretation is that notebook comments can live inside
  `.ipynb` metadata while remaining associated with notebook cells.

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

- Do not add a new top-level field or a new cell field for comments in
  `.ipynb`.
- Use notebook metadata with a Runme namespace for compatibility.
- Use `.ipynb` cell `id` as the anchor when present.
- Map Runme `refId` to `.ipynb` cell `id` when importing/exporting.

## Current Runme Context

The app-facing persistence path is local-first:

```text
NotebookData / editor tabs
  -> local://file/<id>
  -> LocalNotebooks / IndexedDB
  -> optional upstream from LocalFileRecord.remoteId
```

`NotebookData` owns one in-memory `parser_pb.Notebook`. React views render
immutable snapshots. Mutations should go through `NotebookData` and `CellData`,
then autosave through the local mirror.

Cells already have stable `refId` values and `metadata`. The AppKernel
notebook API exposes notebook handles, revisions, cells, metadata, and cell
execution helpers. Codex tools already use explicit cell ids when reading,
updating, and executing cells.

## Storage Decision

Store V0 comments inside the notebook document under top-level notebook
metadata:

```json
{
  "metadata": {
    "runme.dev/comments": {
      "version": 1,
      "threads": []
    }
  }
}
```

Do not store comments in an auxiliary file for V0.

Do not add a new field to cells for V0.

Do not store full threads independently in each cell's metadata.

### Why Inside The Notebook

Inside-the-notebook storage has the right V0 behavior:

- comments survive local autosave,
- Drive copies include comments,
- filesystem-backed notebooks remain self-contained,
- offline editing works without another sync channel,
- imported/exported `.ipynb` files can preserve comments,
- the notebook revision hash reflects comment changes.

The tradeoff is that comments become notebook content. A comment-only change can
trigger notebook sync conflicts and version churn. That is acceptable for V0
because the current product does not have live multi-writer collaboration.

### Why Notebook Metadata

Notebook metadata is the safest compatibility point.

Adding a new cell field would make strict `.ipynb` validation fail. Cell
metadata is valid, but storing full threads in each cell makes global comment
search, orphan handling, and agent dispatch harder. Notebook-level metadata
keeps comments in one place while anchors still point to cells.

Cell metadata may later carry denormalized UI hints such as
`runme.dev/commentCount`, but the source of truth should stay in notebook
metadata.

### When To Revisit Auxiliary Storage

Move comments to auxiliary storage only when one of these becomes a product
requirement:

- independent comment permissions,
- comments on read-only shared notebooks without modifying the notebook file,
- high-volume comment activity that should not churn notebook revisions,
- live multi-user comments before notebook save,
- server-side notifications,
- Drive-native comment interoperability.

If that happens, the embedded metadata model can become an export/cache format
while a per-document comments service becomes canonical.

## Proposed Data Model

Use one document-level metadata object:

```ts
type NotebookCommentsMetadata = {
  version: 1
  threads: CommentThread[]
}

type CommentThread = {
  id: string
  anchor: CommentAnchor
  status: 'open' | 'resolved'
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  author: CommentAuthor
  comments: CommentMessage[]
  agentDispatch?: AgentDispatchState
}

type CommentAnchor = {
  type: 'cell'
  cellId: string
  cellIdKind: 'runme-ref-id' | 'ipynb-cell-id'
  revision?: string
  preview?: {
    cellKind?: 'code' | 'markup'
    languageId?: string
    firstLine?: string
  }
}

type CommentMessage = {
  id: string
  body: string
  htmlBody?: string
  author: CommentAuthor
  createdAt: string
  updatedAt: string
  mentions?: CommentMention[]
}

type CommentAuthor = {
  id?: string
  displayName: string
  email?: string
  avatarUrl?: string
}

type CommentMention = {
  raw: string
  kind: 'agent' | 'user'
  target: string
}

type AgentDispatchState = {
  status: 'pending' | 'sent' | 'acked' | 'failed'
  targetAgent: string
  messageId?: string
  lastError?: string
  updatedAt: string
}
```

Example:

```json
{
  "version": 1,
  "threads": [
    {
      "id": "thread_01jz9a0tq6x6tnmvz8z64k3dse",
      "anchor": {
        "type": "cell",
        "cellId": "code_85a39e07",
        "cellIdKind": "runme-ref-id",
        "preview": {
          "cellKind": "code",
          "languageId": "python",
          "firstLine": "df.groupby('country').revenue.sum()"
        }
      },
      "status": "open",
      "createdAt": "2026-06-11T18:00:00Z",
      "updatedAt": "2026-06-11T18:00:00Z",
      "author": {
        "displayName": "Jane Doe",
        "email": "jane@example.com"
      },
      "comments": [
        {
          "id": "comment_01jz9a10vdt7kz2zh7wqp8m3xq",
          "body": "@codex run this cell and explain the output",
          "author": {
            "displayName": "Jane Doe",
            "email": "jane@example.com"
          },
          "createdAt": "2026-06-11T18:00:00Z",
          "updatedAt": "2026-06-11T18:00:00Z",
          "mentions": [
            {
              "raw": "@codex",
              "kind": "agent",
              "target": "codex"
            }
          ]
        }
      ],
      "agentDispatch": {
        "status": "pending",
        "targetAgent": "codex",
        "updatedAt": "2026-06-11T18:00:00Z"
      }
    }
  ]
}
```

## Comment Anchors

V0 anchors are cell anchors only.

When editing Runme-native notebooks, use `cell.refId`. When importing `.ipynb`,
preserve the Jupyter cell `id` and map it to `refId` if the native model needs
one canonical cell identifier. When exporting `.ipynb`, write the anchor cell
id to the same value as the exported cell `id`.

If a cell is deleted, keep its comment thread in notebook metadata and mark it
as orphaned in the UI by resolving the anchor at render time. Do not delete
comments automatically. The preview gives the user enough context to resolve,
delete, or leave the thread.

If a cell is moved, the thread follows the cell id.

If a cell is duplicated, new cells must get new ids. Comments stay attached to
the original cell only.

## UI Proposal

V0 should use a Google Docs-like split between margin affordances and a global
comments panel.

Notebook body:

- Show a comment icon in each cell toolbar or right gutter.
- Show an active/open count on the icon.
- Click the icon to open the thread composer for that cell.
- Highlight the active cell when a comment thread is selected.
- Show a compact marker for cells with open comments.

Comments panel:

- Dock the panel on the right side of the notebook.
- List open threads first, grouped by notebook order.
- Provide filters for open, resolved, and all.
- Select a thread to scroll the notebook to the anchored cell.
- Support reply, resolve, reopen, edit own comment, and delete own comment.
- Show orphaned threads in a separate section.

Composer:

- Plain Markdown text input for V0.
- Detect `@codex` mentions.
- Submit with `Cmd/Ctrl+Enter`.
- Preserve draft text while the user switches cells.

Accessibility:

- All comment controls need labels.
- The active thread needs focus management between the panel and cell.
- Keyboard shortcuts can follow Docs later: next/previous comment, reply,
  resolve, and exit.

## Agent Hook

Comments should emit a structured event after the notebook model accepts the
mutation and before/after autosave completes. Autosave should not block agent
dispatch, but the event must include enough context for the agent to reload the
notebook if needed.

Proposed event:

```ts
type NotebookCommentCreatedEvent = {
  type: 'notebook.comment.created'
  notebook: {
    uri: string
    name: string
    revision: string
    remoteUri?: string
  }
  thread: {
    id: string
    status: 'open' | 'resolved'
    anchor: CommentAnchor
  }
  comment: CommentMessage
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
```

Dispatch flow:

```text
user submits comment
  -> NotebookData.addComment(...)
  -> comment metadata mutation is committed
  -> NotebookCommentCreatedEvent is emitted
  -> Mention router sees @codex
  -> router sends notebook uri, revision, cell id, comment id, and cell context
     to the Codex conversation bridge
  -> agent response is added as a reply or linked from the thread
```

The mention router should be independent from React. It should subscribe to
notebook model events or a small comment event bus. That keeps AppKernel,
external Codex, and future server-side dispatch from depending on component
lifecycles.

Agent dispatch must be idempotent. Use `(notebookUri, threadId, commentId,
targetAgent)` as the de-duplication key and persist dispatch status in
`agentDispatch`.

## API Surface

Add comment methods to `NotebookData` first:

```ts
class NotebookData {
  listCommentThreads(): CommentThread[]
  addCommentThread(args: {
    cellId: string
    body: string
    author: CommentAuthor
  }): CommentThread
  replyToCommentThread(args: {
    threadId: string
    body: string
    author: CommentAuthor
  }): CommentThread
  resolveCommentThread(threadId: string): CommentThread
  reopenCommentThread(threadId: string): CommentThread
}
```

Then expose an AppKernel API after the model is stable:

```ts
type NotebookCommentMutation =
  | { op: 'createThread'; cellId: string; body: string }
  | { op: 'reply'; threadId: string; body: string }
  | { op: 'resolve'; threadId: string }
  | { op: 'reopen'; threadId: string }

type NotebooksCommentsApi = {
  list(args?: { target?: NotebookTarget; status?: 'open' | 'resolved' | 'all' }): Promise<CommentThread[]>
  update(args: { target?: NotebookTarget; operations: NotebookCommentMutation[] }): Promise<CommentThread[]>
}
```

## Sync And Conflict Behavior

Comments are normal notebook content in V0.

Local autosave should persist comment mutations like cell mutations. Drive sync
should upload the changed notebook JSON. Existing conflict handling should show
comment metadata changes in notebook diffs once diff support includes metadata.

Conflict policy:

- If two edits add different threads, merge should be possible because thread
  ids are unique.
- If two edits append replies to the same thread, merge should order by
  `createdAt` and preserve both replies.
- If one edit resolves a thread while another adds a reply, reopen or keep open
  unless the resolving reply is later than the new reply.
- If the anchor cell is deleted on one side, preserve the thread as orphaned.

This merge policy is future work. V0 can rely on existing notebook conflict
resolution and document the limitations.

## Security And Privacy

Comments are notebook content. Sharing a notebook shares comments. This matches
the Colab behavior but needs UI copy when sharing or exporting.

Agent mentions need explicit product behavior:

- `@codex` should not execute code silently unless the command and current
  product mode allow it.
- The agent payload should include only the anchored cell and document
  identifiers by default.
- Broader notebook context should be requested through existing notebook APIs,
  not stuffed into the event payload.
- Comments may contain secrets; agent dispatch should follow the same data-use
  rules as the AI chat panel.

## Implementation Plan

1. Add parser/serializer helpers for `metadata["runme.dev/comments"]`.
2. Add `NotebookData` comment mutation methods and events.
3. Add unit tests for create, reply, resolve, reopen, orphaned anchors, and
   `.ipynb` metadata preservation.
4. Add a lightweight comments panel and per-cell comment icon.
5. Add mention parsing for `@codex`.
6. Add an agent mention router that receives comment-created events and sends
   structured context to the existing Codex bridge.
7. Add AppKernel comments API once internal model and UI behavior settle.
8. Extend notebook diff handling to summarize comment metadata changes.

## Open Questions

- Should `@codex run this cell` execute immediately, or should it open a
  confirmation affordance in the thread?
- Which identity source should populate `CommentAuthor` for local-only users?
- Should resolved threads remain in exported Markdown representations?
- Should Drive-backed notebooks eventually mirror Runme comments to the Drive
  Comments API for external visibility?
- Should comment-only changes produce the same dirty/sync indicator as cell
  content changes?
- Do we want a document-level unanchored comment type after V0?
