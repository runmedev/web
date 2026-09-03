# CUJ: Concurrent Runme Operation Log

## Goal

Two independent browser sessions can edit the same Drive-backed `.runme`
notebook without lifetime ownership, then explicitly refresh and converge on
the same deterministic cell and comment state.

## Preconditions

- The app, Runme backend, test OIDC server, and fake Drive service are running.
- Both browser sessions use isolated session storage and the same authenticated
  fake-Drive principal.
- A Drive-backed `.runme` notebook contains stable left and right anchor cells.

## Scenario

1. Open the same notebook in sessions A and B and verify both are writable.
2. Insert one different cell in each session between the same two anchors.
3. Save/sync both sessions and click **Refresh** in each.
4. Verify both snapshots contain both insertions in identical position order.
5. In A, add a comment; in B, refresh, reply, resolve, and reopen the thread.
6. Refresh A and verify the same thread content and final open state.
7. Reload both sessions and verify the converged state is durable.

## Acceptance Criteria

- Neither session displays or requests a lifetime ownership transfer.
- Both same-gap inserts survive and their order is deterministic.
- Refresh performs an upstream sync even when the local mirror synced recently.
- Comment, reply, resolve, and reopen operations materialize identically.
- Delete followed by Undo restores a stable cell ID without a duplicate create.
- Reloading preserves every operation and the same final snapshot.
- The automated driver records machine-verifiable assertions, DOM snapshots,
  screenshots, and a walkthrough video under `app/test/browser/test-output/`.

## Automation

The browser scenario should use two isolated `agent-browser` sessions and the
shared Go fake Drive service. It must be registered in
`app/test/browser/run-cuj-scenarios.ts`; unit tests alone are not sufficient
because the scenario must exercise browser OPFS and Web Locks.
