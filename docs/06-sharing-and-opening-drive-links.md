---
name: sharing-and-opening-drive-links
title: Sharing And Opening Drive Links
order: 6
description: >-
  Use this guide when opening a shared Google Drive notebook or folder link,
  generating a share link, or troubleshooting the link handoff flow. It
  explains authentication and synchronization implications, explorer
  behavior, and the relevant App Console helpers. Use the broader Google Drive
  integration guide for initial Drive configuration and storage behavior.
---

# Sharing And Opening Drive Links

## Purpose

The app supports opening shared Google Drive files and folders from links.

## Expected behavior

When a shared Drive link is introduced, the app may need to:

- authenticate Drive access,
- inspect the linked file or folder,
- mirror it into local state,
- mount the necessary folder hierarchy,
- switch the current document once the local entry is ready.

## User-visible implications

- opening a shared link can be asynchronous,
- the app may show a status tab rather than failing immediately,
- the final editable notebook may use a local URI, not the original link.

## Explorer interaction

Drive folders or files associated with a shared link should appear in the
explorer once coordination completes.

## Share-link actions

The explorer can copy share links for remote items that retain a `remoteUri`.
For a Drive-backed `.ipynb` notebook, open the notebook tab's context menu and
choose **Copy Google Colab Link** to copy a link that opens the same Drive file
in Colab. See [IPYNB Notebooks](17-ipynb-notebooks.md) for format and
compatibility details.

## App Console helpers

Use these helpers when a human or AI agent has a notebook reference and needs a
single command from App Console.

```js
const info = await notebooks.resolve(
  'local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018'
)
console.log(info.title)
console.log(info.googleDriveUrl)
console.log(info.markdownLink)
```

`notebooks.resolve(reference)` accepts:

- `local://file/...` local mirror URIs,
- Runme share URLs with a `doc=` query parameter,
- Google Drive file URLs,
- Markdown links whose destination is one of the supported URL forms.

It returns the display title, `localUri`, `remoteUri`, `shareTarget`,
`shareUrl`, and `markdownLink`. `shareTarget` is the base reference used in
Runme share links: the Drive URL when the local notebook has a remote backing
file, otherwise the local URI.

To open a reference without changing the notebook the user is viewing, run:

```js
const opened = await notebooks.open(
  'https://runme.gateway.unified-0.internal.api.openai.org/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F149JKKTgljRiwszwb06Ms74GOYhCOPMNg%2Fview'
)
```

Local references open directly in a notebook tab. Drive references are queued
through the shared-link coordinator, which handles auth, local mirroring, and
opening the resulting local notebook. Neither path changes visible focus. When
the user wants to switch to the opened notebook, call
`await notebooks.focus(opened.localUri || opened.opened)`. The legacy
`notebooks.show(reference)` helper performs both operations.

## Key facts

- Treat link opening as a coordination flow, not just "navigate to URL."
- If the user is not authenticated yet, failure may be temporary and recoverable.
- If the user says "open this shared file," check for Drive-link status or
  coordination progress before concluding the feature is broken.
- Prefer `await notebooks.markdownLink(reference)` when replacing
  `local://file/...` text in Markdown with a title and Runme share URL.
