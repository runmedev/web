# Mounted local folders for Runme notebooks

**Author**: Codex

**Date**: November 22, 2026

**Status**: Draft for review in [PR #454](https://github.com/runmedev/web/pull/454).

## TL;DR

Download a `.runme` notebook, choose **Open local folder** in Explorer, grant access to its containing directory, and open the notebook. Runme edits a browser-private working copy. Its storage worker merges changes in both directions with the file on disk. Each Explorer folder represents a directory on the local filesystem or Google Drive.

## Motivation

People who can download a shared notebook may have no Google Drive OAuth client configured in Runme. A local download gives them a durable file they can edit and share. The former **Local Notebooks** folder looked like a disk location even though its contents lived inside one browser profile. Remove that synthetic location. Every new notebook needs a destination in a mounted directory or in Drive. Existing browser-only notebooks were disposable. The upgrade can leave them orphaned and preserves their bytes.

## Proposal

When the user picks Downloads, the browser gives Runme a directory handle. The storage worker walks the directory tree. Each subdirectory and each supported file gets an IndexedDB record with a local URI. Directory records list their children by local URI. The origin private file system (OPFS) holds the working copy of each notebook. Explorer reads the index, and the editor saves operations to OPFS. Both use the same mirror APIs as Drive.

For example, the directory record for Downloads/team references a child such as `local://file/abc`. The worker maps that file to the selected directory and the relative path `team/notes.runme`. Drive provides stable object IDs. A directory handle exposes a name, and the browser withholds the absolute OS path. Two directories can both be named Downloads. Runme therefore assigns each mount an ID, persists its handle, and uses `isSameEntry` to recognize it when the user picks it again.

On mount, at startup, and every two minutes while Runme runs, the worker enumerates active mounts and queues .runme histories, including files in unopened directories. It merges operations by ID and rechecks the disk revision before replacement. An independent desktop editor can still race the final write. If permission expires, users can edit cached notebooks and reconnect from the folder menu. Removing a mount stops scheduled reconciliation.

## Alternatives

Keeping a browser-only Explorer folder would preserve two meanings of “local” and would give users another place to create files they cannot find on disk. Writing editor changes directly to the directory would couple editing to permission and bypass the operation log used by Drive. Extending the new sync loop to JSON and Jupyter would require whole-document conflict handling. Limiting local folders to the native operation-log format keeps the merge policy explicit.

## Implementation, testing, and deployment

The window handles folder selection and permission prompts. Explorer reads directory membership through the storage owner. The filesystem adapter persists directory identity and guards replacement writes. The storage owner schedules reconciliation independently of Drive authentication and network availability.

The browser regression mounts an isolated test directory, downloads a notebook, places the download in a second directory and mounts it, and opens the copy through Explorer. It then edits a nested notebook that has never been open in the editor and checks that the worker picks up the operation with its tab closed. A subsequent browser edit must reach disk alongside the external operation. It substitutes a real browser directory handle for the native picker. Unit tests cover format filtering, identity reuse, disconnected mounts, and interrupted or conflicting writes.

![A downloaded notebook opened from a mounted Downloads folder](20261122-mounted-folder.png)

Ship through the normal web release after PR review. On an upgraded profile, confirm an old synthetic root stays hidden and a previously mounted directory reconnects. Verify the native picker and permission-recovery prompt on the release build. Rolling back the UI preserves on-disk files and existing OPFS histories.

## References

- [Draft PR and implementation](https://github.com/runmedev/web/pull/454) — Explorer, filesystem adapter, and storage worker changes.
- [Mounted-folder browser scenario](https://github.com/runmedev/web/blob/codex/local-folder-sync-design/app/test/browser/test-scenario-mounted-notebooks.ts) — reproducible end-to-end checks.
- [Operation-log concurrency](https://github.com/runmedev/web/blob/main/docs-dev/CUJs/runme-operation-log-concurrency.md) — how independent edits converge.
- [Codex session](codex://threads/01a203e9-817c-7081-8b44-8e725976f5f6) — design and review history.
