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
