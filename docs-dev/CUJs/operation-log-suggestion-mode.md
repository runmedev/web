# Review operation-log notebook suggestions

## Preconditions

- Open a local or Drive-backed `.runme` notebook.
- Make at least two edits that produce separate debounced operation batches.

## Journey

1. Select **Review suggestions** above the notebook.
2. Confirm a separate **Suggestions · &lt;notebook name&gt;** tab opens while the
   editor tab remains open.
3. Switch between the editor and suggestion tabs. Confirm each preserves its
   view state and reopening **Review suggestions** focuses the existing review
   tab instead of creating a duplicate.
4. Select **Individual suggestions · accept/reject** in the left review panel.
   Confirm it shows the current suggestion, total count,
   summary, decision actions, and discussion thread.
5. Use previous and next in the left panel to move between suggestions while the
   notebook diff remains in the independently scrolling right canvas.
6. Confirm inserted cells have a green box and deleted cells have a red box with
   strike-through.
7. Confirm a changed text cell shows inserted text in green and deleted text in
   red with strike-through.
8. Add a comment, then reply to it. Confirm the thread uses the same compact
   author, timestamp, message, and indented-reply hierarchy as Google Drive
   comments. Reload and confirm both remain attached to the same suggestion.
9. Reject the suggestion. Select **Edit view**, confirm the review tab closes,
   and confirm the rejected operations no longer materialize in the editor.
10. Review the same suggestion again and accept it. Return to the editor and
    confirm its operations materialize again.

## Expected result

Navigation, decisions, comments, and replies survive reload and synchronize as
part of the `.runme` operation log. No review action deletes operation history.
