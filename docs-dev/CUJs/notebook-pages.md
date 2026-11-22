# Edit two pages in the same notebook

1. Open a local .runme notebook with a timeline cell. In Outline, use **Add page** (+) to create Investigation. The original cell is still on Main.
2. Open Main from Outline. Right-click the timeline cell, choose **Move to page…**, and select Investigation. Expand Investigation to see the timeline's Markdown headings.
3. Create Postmortem and add a Markdown cell. Select Investigation from Outline and edit its timeline. Verify both page tabs share a border with the notebook tab. Select a heading under Postmortem and verify the editor focuses the corresponding cell.
4. Rename a page through its row menu. Drag its title or page icon above or below another page and check the new order. Unassigned cells appear on whichever page is first. Cells assigned to a page stay there when pages move. Close the original notebook tab and verify its name still labels the group.
5. Reload and reopen the notebook. Verify that both edits and the new page order persist. Removing a page keeps its cells accessible on the effective default.

## Arrange and close workspace tabs

1. Open a notebook and two of its pages. Drag a page title onto the left half of the notebook tab, then onto the right half of another page tab. Verify the insertion marker and resulting order. Reload and verify the tab order. The page order in the Outline stays the same.
2. Select each tab. Its white surface, including its close button, should meet the document below. Inactive tabs have a short vertical separator.
3. Right-click a middle tab and choose **Close All Tabs to the Right**. Verify the clicked tab and its left neighbors remain. The command is disabled on the last tab.
4. Right-click a remaining tab and choose **Close All Tabs**. Reopen the notebook from Explorer and verify its pages and cells are still available.
