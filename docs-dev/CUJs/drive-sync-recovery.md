# Recover Drive sync without another edit

## Intent

Pending saves and failed reads survive a reload and recover when Drive becomes
available. See [design](../design/20260923_drive_sync_recovery.md).

## Setup

Use disposable Drive-backed `.json`, `.ipynb`, and `.runme` notebooks and a dev
build. Keep an independent upstream copy for verification. Do not induce errors
on a user's unsaved production notebooks.

## Journey

1. Edit and save a notebook while Drive requests are unavailable. Confirm local
   content is preserved and Drive Status reports an error and last attempt.
2. Restore connectivity/auth without editing. Verify a reconciliation wake-up
   retries after its recorded eligibility (or immediately on auth recovery).
3. Verify Drive receives the local change, the error/deadline clear, and the last
   successful-sync timestamp advances. Reopen to confirm content.
4. Repeat with a reload before recovery. Confirm the saved error/deadline survive.
5. Fail an initial download before any local edit. Restore access and verify the
   remote content downloads without uploading an empty placeholder.
6. Keep one failing file beside a recoverable file. Verify the second still syncs.
7. Open two tabs with pending failures. Confirm per-file cross-tab locking and
   retry deadlines prevent sequential duplicate retries after one failure.
8. Verify an existing conflict is preserved for explicit resolution and a healthy
   notebook is not repeatedly uploaded by periodic reconciliation.

## Automated coverage and evidence

Storage and scheduler Vitest tests cover these transitions using mocked Drive
transport and the production reconciliation path; component tests cover status
labels. Missing/corrupt OPFS and concurrent backfill are storage-level tests.
These tests do not claim a live Drive/browser end-to-end run. For a manual run,
record the build, format, local/upstream checksums, attempt/success timestamps,
and before/after status screenshots without credentials or notebook contents.
