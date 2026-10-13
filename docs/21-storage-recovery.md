---
name: storage-recovery
title: Restart Runme storage
description: Recover a storage worker version mismatch without closing the browser or losing notebook editor copies.
order: 21
---

# Restart Runme storage

After an update, an older shared storage worker can reject a newer Runme tab. A **Restart Runme** banner appears above the notebook pane and on **Google Drive Sync Status** when Runme detects a storage version mismatch, disconnection, startup failure, or unresponsive request.

Click **Restart Runme**. All connected tabs on this Runme site preserve their open notebook editors, pause new edits, and acknowledge the restart. The worker finishes pending storage and network writes, then shuts down and reloads those tabs. Other sites and the browser stay open. Pending Drive sync resumes from saved local state.

Recovery copies are stored in each tab's session storage before reload. After restart, the banner offers downloads of those copies. If edits are missing, download the relevant JSON notebook and import it as a separate notebook. Copies are never automatically replayed over the original operation log or a newer revision. Keep the tab open until you have recovered any needed copies; they are not synced to Drive.

A running cell, pending notebook review, full recovery storage, or a tab that does not acknowledge prevents the coordinated restart. The reason appears in the banner. Resolve it and retry. Runme never forces termination of an active write just because a timer expired.

Workers and tabs loaded before this recovery feature cannot participate. The button reports that limitation. Preserve unsaved edits, navigate every Runme tab on the same site away (for example, to `about:blank`), then return. This one-time step does not require closing tabs or the browser. Subsequent compatible versions can use coordinated restart.
