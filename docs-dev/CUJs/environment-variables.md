# CUJ: Configure browser environment variables

1. Open **Environment** from the table icon in the left navigation.
2. Add `OPENAI_ORG_ID=org_example` and `OPENAI_PROJECT_ID=proj_example`.
   Verify both appear in the table. Attempt to add the project again and verify
   a duplicate error without overwriting it.
3. Open `docs/environment.json`, run its JavaScript cell with **JS → browser**,
   and verify that it prints the configured organization and project headers.
4. Reload the page. Verify Environment remains selected and both values remain.
5. Edit the project value, cancel, and verify storage is unchanged. Edit again,
   save, and rerun the JavaScript cell to verify the updated value.
6. Set `runme.env.FROM_JS` using browser `localStorage.setItem`. Select **Refresh
   variables** and verify the value appears. Changes from a second tab on the
   same origin should appear without manually refreshing.
7. Delete the project variable and verify its lookup returns `null` while the
   organization value and unrelated application settings remain unchanged.
8. Check that the table and controls work at desktop and tablet widths. With a
   long table, selecting Edit should focus the value input and scroll it into view.

Storage-failure coverage lives in `EnvironmentPanel.test.tsx`: blocked reads,
quota failures retaining draft input, and unsuccessful deletes.
