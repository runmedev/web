---
name: keyboard-shortcuts
title: Keyboard Shortcuts
order: 23
description: >-
  Find Runme keyboard shortcuts by focused cell or panel. Learn how to switch
  Markdown and HTML between rendered and source modes, run code, submit
  comments, and navigate the App Console.
---

# Keyboard Shortcuts

## Toggle a Markdown cell

Click the rendered text of a Markdown cell, or press **Tab** until the cell has focus. Press **Esc** to edit its source. Press **Esc** again to render it and return focus to the rendered cell. Empty Markdown cells stay in the editor until you enter some text.

| Focus | Keys | Action |
| --- | --- | --- |
| Rendered Markdown cell | **Esc** | Open the source and focus the editor. In a read-only notebook, the source opens for viewing. |
| Rendered Markdown cell itself | **Enter** or **Space** | Also opens the source. On a focused link, **Enter** follows the link. |
| Markdown source | **Esc** | Render the cell. |
| Editable Markdown source | **Ctrl+Enter** | Run the cell to render it. Use **Control** on macOS too. |
| Rendered HTML cell itself | **Esc**, **Enter**, or **Space** | Open editable HTML source. |
| HTML source | **Esc** or **Ctrl+Enter** | Preview the HTML when the source has content. |
| Code cell source | **Ctrl+Enter** | Run the cell. |
| Selected source in a cell with source comments enabled | **⌘+Option+M** on macOS, **Ctrl+Alt+M** on Windows or Linux | Start a comment on the selection. |
| Source editor | **F1** | Open the editor command palette to discover additional editing commands and their shortcuts. |

## App Console and conversations

| Focus | Keys | Action |
| --- | --- | --- |
| App Console draft | **Shift+Enter** | Execute the current console cell. |
| App Console draft | **Alt+P** / **Alt+N** (Option on macOS) | Recall the previous / next history entry. |
| Notebook comment, review discussion, or agent message composer | **Enter** / **Shift+Enter** | Send the message / insert a line break. |
| Suggestion comment or reply field | **⌘+Enter** or **Ctrl+Enter** | Submit the comment or reply. |

## Workspace navigation

| Focus | Keys | Action |
| --- | --- | --- |
| Workspace | **⌘+O** on macOS, **Ctrl+O** on Windows or Linux | Search Explorer notebooks by name or paste a notebook link. |
| Workspace tab strip | **←** / **→**, **Home** / **End** | Navigate between tabs or jump to the first / last tab. |
| Page rename field | **Enter** / **Esc** | Save / cancel the rename. |
| Drive status, account button, or diff comment control | **Shift+F10** or **Menu** | Open the control’s context actions or authentication details. |
| Diff comment menu | **↑** / **↓**, **Home** / **End** | Navigate actions. **Enter** activates the focused action. |
| Logs source tabs | **←** / **→**, **Home** / **End** | Switch between application and worker logs. |
| Dialog or context menu | **Esc** | Dismiss it. |
