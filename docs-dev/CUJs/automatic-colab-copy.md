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

Automated coverage: `derivedIpynb.test.ts`, `derivedNotebookModel.test.ts`,
`NotebookPropertiesDialog.test.tsx`, and the operation-log export integration
cases in `storage/local.test.ts`. The slow-upload test holds a real promise
pending while another journal save commits and is read back from storage.
