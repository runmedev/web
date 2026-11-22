# Local folders and browser drafts

A user without Google Drive credentials should be able to download a notebook, mount its containing folder, edit it in Runme, and open the updated file from disk. Use the existing filesystem mount and OPFS mirror for this workflow. Show each mount by its directory name. Replace the always-visible **Local Notebooks** root with **Browser drafts**, visible when it contains files. Keep New notebook available from the explorer toolbar when the root is empty.

## What the code does today

| Path | Behavior | Consequence |
| --- | --- | --- |
| `components/Workspace/WorkspaceExplorer.tsx`, `storage/local.ts` | The explorer adds `local://folder/local` automatically and synthesizes it again if absent. Its metadata selects files whose upstream is local. | This is a recovery path for browser-only work. It is neither a disk directory nor the inventory of all OPFS mirrors. |
| `storage/fs.ts`, `storage/fsdb.ts` | Open local folder uses a read/write directory picker and stores the handle in IndexedDB. Each pick gets a new UUID. Directory expansion lists disk entries. | Picking the same directory twice can create two upstream identities for one file. |
| `lib/notebookDataController.ts`, `storage/local.ts` | Opening an upstream URI calls `addFile`, which finds or creates a stable local file URI by upstream URI. Filesystem sync initializes a .runme log in OPFS and merges operations by ID. JSON and Jupyter use separate serialized paths. | Reuse the editor, operation log, and format codecs. A second notebook store for editing would split ownership. |
| `lib/explorerSync.ts`, `storage/storageOwnerRuntime.ts`, `storage/local.ts` | The explorer periodically refreshes listings. The storage owner periodically rescans Drive work. Saves can queue filesystem writes, and the per-file queue gates network availability only for Drive work. | Refreshing a folder does not ingest edits to previously opened files. A Drive-only recovery scan misses filesystem work after restart. |

Paths in the table are relative to `app/src`.

## Mount, open, save

1. **Mount folder** runs from a user gesture. Compare directory handles with `isSameEntry` and reuse the existing workspace ID. Persist the mount selection separately from cached handles so removing a root stops future scans. Keep existing workspace IDs and local notebook URIs valid.
2. List supported notebook files in expanded directories. Materialize bytes on first open. A folder containing one notebook and a large source tree should cost one notebook import. Persist enough listing metadata to show previously visited directories when permission expires.
3. Persist editor changes through the storage owner before reporting **Saved in browser**. Drive and disk are separate destinations. Display **Synced to folder** only after successful reconciliation. Show pending writes, the last error, **Sync now**, and **Reconnect folder** on the affected mount or notebook.
4. On startup and every two minutes while Runme is running, reconcile previously materialized files in active mounts, including closed tabs. Use the existing per-file exclusion and bounded queue. Scan in pages and probe clean files for external edits. Prioritize pending writes. Query permission silently, coalesce concurrent passes, and retry when the user reconnects. No OAuth or network connection is required.
5. Treat Download as a snapshot. Export the latest committed .runme operation log, including notebook identity and history. A browser file input can reopen the download as an independent browser draft where folder picking is unavailable. In a supported browser, mounting the download directory enables continued writeback.

## Reconciliation and failure behavior

For .runme, read and validate both headers, union operations by ID, append missing local operations to OPFS, and write the merged document to disk only if disk is missing operations. Recheck the observed disk revision immediately before replacing the file. A changed revision triggers a fresh read and merge. The browser cannot lock out unrelated desktop editors. Size and modification time alone can miss equal-size changes, so compare content when verifying a write. Advance the baseline only after the write closes and the committed local revision is still current. An interrupted pass can repeat the union.

For JSON and .ipynb, compare local and disk content with the last agreed baseline. Pull a disk-only change, push a local-only change, and skip an unchanged file. Preserve Jupyter fields using the existing shadow codec. Two differing changes require a visible conflict with both copies available for export. The existing serialized path logs this case and returns normally. Make conflict an explicit result before enabling periodic scans.

If a file disappears or acquires a different notebook ID, retain the last good mirror and mark the upstream missing or replaced. Let the user reconnect or save a copy. Expired permission pauses disk I/O while editing continues in OPFS. Unmounting forgets the active connection and keeps pending edits recoverable under Browser drafts. Recheck mount membership before queued I/O. Scope polling to the lifetime of the running app.

## Rollout and acceptance

1. **Identity and recovery.** Deduplicate new mount selections, keep old URIs resolving, and expose reconnect. Surface unbacked drafts by the existing root URI. Verify that an existing draft remains discoverable after closing its tab and reloading.
2. **Reconciliation.** Extend storage-owner discovery to active filesystem mounts. Reuse the existing filesystem merge and serialized sync paths. Test disk-only, OPFS-only, concurrent edits, unchanged files, interrupted writes, two tabs, and detached mounts. Verify that polling a clean JSON or Jupyter file leaves its modification time unchanged.
3. **Explorer and portability.** Add Download and Open file entry points independent of Drive configuration. Test with no OAuth client and networking disabled. Download, mount the folder, edit, close the notebook tab, edit on disk, wait for reconciliation, and reopen. Both edits must survive in the same .runme notebook. Repeat with revoked permission and verify recovery from the browser copy.
