# Automatically publish a Colab copy

1. Open a Drive-backed `.runme` notebook with text, code, and saved output.
2. Right-click its tab, open **Notebook properties**, and enable
   **Automatically save a Colab copy (.ipynb)**. Close and reopen properties;
   verify the checkbox remains enabled.
3. Allow the background export to finish. Open **Open Colab copy** and verify
   the cells and outputs match the source and the first cell warns that this
   generated file will be overwritten.
4. Open the generated `.ipynb` in Runme. Verify its header links to the source,
   editing and execution controls are disabled, and there is no request-write
   access button for the generated notebook.
5. Edit the source and save. Verify the same Drive copy ID receives the update.
6. Disable automatic export, edit and save again. Verify the source changes
   and the last generated copy remains unchanged.
7. Re-enable export. Simulate an upload failure and verify the source save still
   completes, properties reports the copy error, and a later successful sync
   retries the export.
8. Open the same source in independent browser profiles and trigger concurrent
   exports. Verify profiles adopt an observed shared copy identity and recheck
   claims before creation. The public property is client-side coordination,
   not an atomic lock; simultaneous independent creation can still race.
9. Simulate a Shared Drive create whose response is lost. Verify subsequent
   sync waits for confirmation. If no file was created, use the warning-gated
   recovery action in properties and verify export can resume.
10. Pause one profile during discovery or upload. In another profile, move and
    rename the source, add content, and finish exporting. Resume the old profile;
    verify its preflight detects the newer copy version. A rejected
    version check queues fresh work; a mirror missing previously exported
    operations reports that the source must be synced first.

Automated coverage: `derivedIpynb.test.ts`, `derivedNotebookModel.test.ts`,
`NotebookPropertiesDialog.test.tsx`, and the operation-log export integration
cases in `storage/local.test.ts`. The slow-upload test holds a real promise
pending while another journal save commits and is read back from storage.
`storage/derivedCopy.test.ts` exercises independent clients with only shared
shared remote claim state (no shared local lock), and `storage/drive.test.ts` verifies
the v3 property check, write, and readback for both browser and token transports.
Out-of-order profile tests verify content and placement together. Both transports
are checked for multipart updates after a client-side version preflight without
ETags or If-Match. A write between the final preflight and upload can still
race; these tests do not assert a server-side lock.

## Workload identity to end-user export

1. Create and export a source notebook using workload identity. Verify the
   generated file has `properties.runmeDerivedFrom` equal to the source Drive ID.
2. Open and save the same source using an end user's OAuth identity. Verify the
   existing Colab file ID receives the new content, even with no visible
   `appProperties`. No duplicate copy should be created.
3. Repeat with a legacy export whose private marker is invisible to the end user.
   Verify its embedded source provenance is checked and the ordinary Drive
   property is added before the same copy is updated.
4. Point the source claim at an ordinary `.ipynb` or one with a different source
   marker. Verify export fails and neither that file's content nor its metadata
   changes. A matching filename is not ownership evidence.
5. Lose the response to a Shared Drive create, then retry with the other identity.
   Verify discovery uses the shared source property and recovers the same file.

`storage/derivedCopyOwnership.test.ts` exercises the REST client with separate
workload and end-user tokens, shared properties and no private markers. It also
covers legacy migration, unrelated-file refusal and ambiguous recovery.
