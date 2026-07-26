# WebMCP External Control

## Purpose

Runme Web exposes WebMCP tools that let an external browser controller inspect,
edit, and execute work in an open Runme tab. This page describes how to select
the intended tab and notebook safely before using those tools.

This is the supported integration path for Codex and other external agents.
Runme does not include a built-in AI Chat panel.

Browser tab control is exclusive: one controller session can control one tab
at a time. Concurrent sessions should target different Runme tabs.

## Session ID sources

Runme exposes the same browser session ID in two places:

- the page URL query parameter: `?session=<session-id>`
- the AppKernel helper: `await app.getSessionID()`

The URL query parameter is a routing hint. The AppKernel helper verifies the
session from inside the selected tab.

## Required tab selection workflow

When a user identifies a specific Runme session, the external controller
should:

1. Inspect open browser tabs.
2. Find Runme tabs whose URL contains `session=<requested-session-id>`.
3. Claim only the matching tab.
4. Verify the claimed tab by running AppKernel code:

```js
console.log(await app.getSessionID())
```

5. Continue only if the printed session ID matches the requested session ID.

If no tab has the requested `session` query parameter, do not guess. Ask the
user to open or identify the correct Runme tab.

If a tab URL matches but `await app.getSessionID()` returns a different ID,
treat that tab as unsafe for the requested session and do not mutate notebooks
in it.

## Finding the current tab session

An attached controller can report or confirm the current session through
AppKernel:

```js
const sessionId = await app.getSessionID()
console.log(sessionId)
```

This works from the App Console, AppKernel notebook JavaScript cells, and
WebMCP `ExecuteCode` calls that run in the AppKernel runtime.

## URL behavior

Runme adds or replaces `session=<session-id>` in the URL on startup while
preserving other query parameters and hash fragments. Session IDs are
human-readable random names, such as `calm-harbor`.

Runme uses Web Locks to avoid live-tab session collisions. A tab may briefly
write an initial name and then replace it if another Runme tab already holds
that session lock. Read the current URL and still verify it with
`await app.getSessionID()` before acting.

The session ID is generated per page load. If a user duplicates a browser tab,
the browser initially copies the old URL, but the duplicated Runme page should
replace the copied `session` query value with a new ID as soon as the app
starts.

Examples:

```text
https://runme.example/?session=calm-harbor
https://runme.example/?doc=local%3A%2F%2Fdemo.runme.md&session=brave-summit#cell-a
```

Use the `session` query parameter only to locate candidate tabs. Before taking
action, verify it with `await app.getSessionID()`.

## Notebook safety rule

Session selection and notebook selection are separate. After verifying the
correct tab session, resolve the intended notebook to a concrete notebook URI
and use that URI or its handle for later operations.

Do not rely on the current notebook after the initial resolution. The user may
switch notebooks while an external controller is working.

## Drive-backed notebook lookup

When a user identifies a Drive-backed notebook by name or metadata rather than
by URL, use Runme's AppKernel Drive API instead of searching the rendered page:

```js
const result = await drive.search({
  q: "name = 'eval_read.json' and trashed = false",
  orderBy: 'modifiedTime desc',
  pageSize: 100,
  fields: 'nextPageToken,files(id,name,mimeType,modifiedTime)',
})

if (result.files.length !== 1) {
  throw new Error(`Expected one notebook, found ${result.files.length}`)
}
await notebooks.show(result.files[0].uri)
```

`drive.search` accepts a Google Drive v3 `files.list` request, including its
query grammar, shared-drive parameters, ordering, field selection, and
pagination. Include `id` and `mimeType` in `fields` so Runme can add a
notebook-ready `uri` to each result. In WebMCP code mode, this call runs through
the authenticated AppKernel and does not require another Drive integration.

## Handling partial notebook update failures

Controllers that mutate notebooks through WebMCP should run JavaScript with
`ExecuteCode` and catch `notebooks.update` failures inside that JavaScript.
The tool returns merged stdout and stderr text, so structured failure details
are visible only when the executed code catches the error and prints the fields
it needs.

`notebooks.update` can apply multiple operations. If operation `K + 1` fails
after the first `K` operations succeed, the promise rejects with an error whose
`code` is `NOTEBOOK_UPDATE_FAILED`. Its `details` include:

- `appliedOperationCount`: number of operations completed before the failure
- `failedOperationIndex`: zero-based index of the failed operation
- `operationStatuses`: per-operation status values
- `beforeHandle`: notebook handle before the update started
- `afterHandle`: notebook handle after the failure

Use this pattern:

```js
const doc = await notebooks.get({ uri: 'local://file/demo.runme.md' })

try {
  const updated = await notebooks.update({
    target: { handle: doc.handle },
    operations: [
      {
        op: 'update',
        refId: 'cell-a',
        patch: { value: 'echo updated' },
      },
      {
        op: 'update',
        refId: 'missing-cell',
        patch: { value: 'echo missing' },
      },
      {
        op: 'remove',
        refIds: ['cell-b'],
      },
    ],
  })

  console.log(JSON.stringify({ status: 'ok', handle: updated.handle }))
} catch (error) {
  if (error?.code === 'NOTEBOOK_UPDATE_FAILED') {
    const current = await notebooks.get({
      handle: error.details.afterHandle,
    })

    console.log(
      JSON.stringify({
        status: 'partial_failure',
        appliedOperationCount: error.details.appliedOperationCount,
        failedOperationIndex: error.details.failedOperationIndex,
        operationStatuses: error.details.operationStatuses,
        currentHandle: current.handle,
      })
    )
  } else {
    throw error
  }
}
```

The reread stays inside the `NOTEBOOK_UPDATE_FAILED` branch where `error` is in
scope. Do not assume the whole update rolled back. `notebooks.update` reports
which operations were applied; it does not make multi-operation updates fully
transactional.
