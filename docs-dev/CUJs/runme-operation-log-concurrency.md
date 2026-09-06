# CUJ: Concurrent Runme Operation Log

## Goal

Two independent browser sessions can edit the same Drive-backed `.runme`
notebook without lifetime ownership, explicitly sync with Drive, then refresh
from each session's local OPFS journal and converge on the same deterministic
cell and comment state.

## Preconditions

- The app, Runme backend, test OIDC server, and fake Drive service are running.
- Both browser sessions use isolated session storage and the same authenticated
  fake-Drive principal.
- A Drive-backed `.runme` notebook contains stable left and right anchor cells.

## Scenario

1. Open the same notebook in sessions A and B and verify both are writable.
2. Insert one different cell in each session between the same two anchors.
3. In each session, click the circular Google status control to sync with
   Drive and wait for the status to return to synced.
4. Click the tab **Refresh** icon in each session to materialize its current
   local OPFS operation log.
5. Verify both snapshots contain both insertions in identical position order.
6. In A, add and Drive-sync a comment. In B, Drive-sync, refresh from OPFS,
   reply, resolve, reopen the thread, and Drive-sync those operations.
7. In A, Drive-sync and refresh from OPFS, then verify the same thread content
   and final open state.
8. Reload both sessions and verify the converged state is durable.

## Acceptance Criteria

- Neither session displays or requests a lifetime ownership transfer.
- Both same-gap inserts survive and their order is deterministic.
- The circular Google status control performs explicit upstream Drive sync.
- The tab Refresh control reads only the local OPFS journal and performs no
  upstream I/O.
- Comment, reply, resolve, and reopen operations materialize identically.
- Delete followed by Undo restores a stable cell ID without a duplicate create.
- Reloading preserves every operation and the same final snapshot.
- The automated driver records machine-verifiable assertions, DOM snapshots,
  screenshots, and a walkthrough video under `app/test/browser/test-output/`.

## Automation

The browser scenario should use two isolated `agent-browser` sessions and the
shared Go fake Drive service. It must observe the Drive revision before and
after local Refresh to prove Refresh performs no upstream I/O, and it must be
registered in `app/test/browser/run-cuj-scenarios.ts`; unit tests alone are not
sufficient because the scenario must exercise browser OPFS and Web Locks.

## Intervening revision recovery

9. Pause A after its v3 version preflight. Write B's different operation as R1,
   then let A upload R2. R2 must initially contain only A's operations, so a
   head-only check would miss B's overwritten write.
10. Verify A lists all revision pages, retains and reads R1, appends B's
    operation to OPFS, and uploads a union. Sync B and verify both journals and
    Drive contain both operations. Reload each isolated browser profile and
    verify the same operation IDs remain durable.
11. Reject a revision retention/download request, then reload and retry. Verify
    the checkpoint retains the unfinished revision, local edits survive, and
    sync does not report success. Also test an upload whose response is lost.

`test-scenario-drive-revision-recovery.ts` is registered in the scenario runner.
It exercises step 9–10 through production storage modules in two isolated
browsers, real OPFS/IndexedDB/Web Locks, and the Go fake's one-shot intervening
write. Its JSON artifact records local/remote operation IDs, checkpoints, and
network requests proving historical retention and v3-only access. This storage
scenario does not claim to automate the UI/comment steps above. Failure/reload,
late-writer, metadata-only version changes, and local-append races have separate
regression cases in `storage/local.test.ts`; transport pagination and retention
are tested in `storage/drive.test.ts` and the Go fake tests.

Recovery is best-effort, not an atomic compare-and-swap. Revision IDs are opaque,
File.version can change without a content revision, retained revisions are
limited to 200, and unavailable observed history must leave sync pending.
