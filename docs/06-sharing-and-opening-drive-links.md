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

## High-value facts for Codex

- Treat link opening as a coordination flow, not just "navigate to URL."
- If the user is not authenticated yet, failure may be temporary and recoverable.
- If the user says "open this shared file," check for Drive-link status or
  coordination progress before concluding the feature is broken.
