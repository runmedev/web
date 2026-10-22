# CUJ: Refresh explorer folders without a context menu

1. Mount a Drive folder with a nested folder and open the nested folder. Change
   folder contents in Drive (add, rename and remove files).
2. With Runme visible, wait one minute. Verify the root and expanded folder show
   the upstream changes without collapsing the tree or replacing notebook edits.
   Collapsed descendants should not be recursively fetched. Expand one to load it.
3. At a 390px phone viewport, tap **Sync folders**. Verify the button is visible
   even without File System Access support and requires no context menu. On desktop,
   verify it sits immediately left of **Open local folder**.
4. Delay a request and tap repeatedly. Verify one pass, a spinning disabled button,
   and continued access to the existing listing. Disconnect and retry; verify an
   error message, preserved listing and successful refresh after reconnecting.
5. Check automatic refresh pauses offline/hidden and unmounting stops its timer.
6. Run `await explorer.sync()` in App Console and sandbox code mode; verify the
   same behavior and `{ refreshed, failed }` result.

Automated coverage: `explorerSync.test.ts`, `WorkspaceExplorer.test.tsx`, the
shallow-folder regression in `local.test.ts`, and the app/sandbox/code-mode runtime
suites. Browser verification should capture toolbar screenshots at desktop and
phone sizes in `app/test/browser/test-output/`.
