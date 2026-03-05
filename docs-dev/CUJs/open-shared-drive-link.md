# Scenario: Open shared Google Drive link

This scenario validates that the app can consume shared Google Drive file and
folder links, persist pending work when Drive auth is unavailable, complete the
load after the user refreshes with a valid credential, and expose app share
links from the Explorer context menu.

## Preconditions

- Web UI is running at `http://localhost:5173`.
- Runme backend agent is running at `http://localhost:9977`.
- Fake Google Drive server is running locally for browser tests.
- `agent-browser` is installed and available on `PATH`.

## User journey

1. Open the app with a shared Google Drive notebook URL in `?doc=...`.
2. The app consumes the URL, removes `?doc=...` from the address bar, and shows
   the Drive Link Status tab because Google Drive auth is not currently
   available.
3. Refresh after a valid Google Drive credential becomes available locally.
4. The app loads the shared notebook from the fake Drive backend.
5. The containing Drive folder is added to Explorer automatically.
6. The file and its containing folder expose `Copy Share Link` in the Explorer
   context menu.
7. Open the app with a shared Drive folder URL in `?doc=...`.
8. Refresh after a valid Google Drive credential becomes available locally.
9. The app mounts the shared folder in Explorer and lists its contents.

## Machine-verifiable acceptance criteria

- [ ] The URL query parameter `?doc=` is removed after the shared link is queued.
- [ ] The `Drive Link Status` tab appears while the shared link is pending.
- [ ] The status tab lists the pending shared Drive URI.
- [ ] After refresh with a valid stored Drive token, the shared notebook opens.
- [ ] Explorer shows the containing folder `Shared Drive Folder`.
- [ ] Explorer lists the notebook `shared-drive-notebook.json`.
- [ ] Explorer file nodes expose a `Copy Share Link` action that copies an app
      share URL for the Drive file.
- [ ] Explorer folder nodes expose a `Copy Share Link` action that copies an app
      share URL for the Drive folder.
- [ ] A shared Drive folder URL in `?doc=...` mounts the folder after auth is
      available.
- [ ] Mounted shared folders can be expanded to show `shared-drive-notebook.json`.
