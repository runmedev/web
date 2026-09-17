# Restore a notebook session after a host restart

## User outcome

A host that remembers only the Runme URL can reopen the ordered notebook tabs and
selected notebook. A second live tab using that URL gets independent state.

## Automated scenario

`app/test/browser/test-scenario-durable-sessions.ts` is registered in the browser
CUJ suite. It uses real Chromium, a disposable persistent profile and local .runme
files; no credentials or runner are needed.

1. Create two notebook files and migrate their legacy open-list/selection.
2. Close the entire browser process and relaunch the same profile with the URL.
   Assert sessionStorage was empty before startup, then verify order, selection,
   session ID and rendered contents.
3. Clone the URL and sessionStorage into another tab while the original owns its
   lock. Verify the clone gets a new ID and empty list without changing the owner.
4. Edit the restored markdown using Monaco keyboard events. Wait for autosave,
   restart the browser again and verify the edited content.
5. Close all notebooks and restart; ensure none are resurrected.

The scenario records videos for each lifecycle phase and a restored-workspace
screenshot under `app/test/browser/test-output/`. Assertion failures capture a
screenshot. The suite uploads these artifacts through its existing pipeline.

## Unit coverage and limits

`durableNotebookSessions.test.ts` covers migration, malformed and oversized records,
quota failures, unavailable locks, invalid URL IDs, pagehide write suppression,
7-day expiry, a 50-inactive-session cap, frozen live owners, and ownership or
activity changing during cleanup. Deleting restore metadata never deletes notebook
content. No cleanup runs while the app is closed; the next visit removes expired
records. Browser storage clearing and cross-origin/profile restoration are outside
this browser-local recovery contract.

See [the design](../design/20260917_durable_notebook_sessions.md) for the rationale.
