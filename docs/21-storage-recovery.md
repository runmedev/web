---
name: storage-recovery
title: Restart Runme storage
description: Recover a storage worker version mismatch without closing the browser or losing notebook editor copies.
order: 21
---

# Restart Runme storage

After an update, an older shared storage worker can reject a newer Runme tab. A **Restart Runme** banner appears above the notebook pane and on **Google Drive Sync Status** when Runme detects a storage version mismatch, disconnection, startup failure, or unresponsive request.

Click **Restart Runme**. Runme first copies every loaded editable notebook in the initiating tab to session storage, before contacting the worker. Once the worker responds, all connected tabs pause edits, copy their editors, and acknowledge the restart. Every notebook is copied before waiting for ordinary saves. The worker finishes pending storage and network writes, then shuts down and reloads those tabs. Pending Drive sync resumes from saved local state.

If storage cannot respond, use **Get recovery copies** in the banner. This captures the current loaded editors directly from memory, without contacting the worker or using session storage. Download each notebook using the buttons that appear. This also works when session storage is full or unavailable. Capture again after further edits; these are snapshots, not continuous backups. Confirm that the downloaded files contain your edits before leaving the page.

Session recovery copies survive a reload of the same tab. They do **not** survive closing the tab, are not synced to Drive, and are not a substitute for persistent autosave. After restart, the banner offers downloads of earlier snapshots. If edits are missing, download the relevant JSON notebook and import it as a separate notebook. Copies are never automatically replayed over the original operation log or a newer revision.

A running cell, pending notebook review, full recovery storage, or a tab that does not acknowledge prevents the coordinated restart. The reason appears in the banner. Resolve it and retry. A timeout cancels waiting and releases editors, but does not cancel an underlying commit or force worker termination. Downloads remain available while preparation is waiting.

A worker that never acknowledges restart may be unresponsive, disconnected, or too old to support the protocol. The timeout alone does not identify the cause. The banner reports whether this tab completed its backup; it cannot promise that other tabs did. Download current editor copies in **every** Runme tab before navigating all tabs on this site away and returning. No automatic reload occurs on a failed restart.

Request timeouts emit structured `storage.owner` logs with the method, request ID, elapsed time, and pending request count. Runme then sends a bounded diagnostic probe independently of normal storage requests. Compatible workers report an instance ID and uptime, initialization state, connected tab count, pending credential requests, scan/restart state, and up to ten oldest requests with their wait stage and age. A reply establishes that the worker can process messages, not whether a timed-out write committed. A missing reply does not by itself prove a deadlock, crash, or out-of-memory failure. These diagnostics exclude notebook contents, notebook URIs, and credentials.
