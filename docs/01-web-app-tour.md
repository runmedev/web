# Web App Tour

## Main layout

The main workspace has four functional areas:

- left toolbar: toggles side panels and auth/Drive actions,
- side panel: file explorer or AI chat,
- center pane: notebook tabs and notebook content,
- bottom pane: App Console and Logs.

## Left toolbar

Buttons currently map to:

- explorer panel,
- AI chat panel,
- Google Drive auth/sync status,
- login/logout.

## Side panel

Two primary panels exist:

- `Explorer`: workspace folders and notebooks,
- `AI Chat`: ChatKit-based assistant UI with multiple harness backends.

## Notebook area

This is the primary editing and execution surface.

- notebooks open in tabs,
- code cells show execution output inline,
- markdown cells render formatted content,
- Drive-link status can appear as a synthetic tab when needed.

## Bottom pane

The bottom pane is shared by:

- `App Console`: configuration and scripted control surface,
- `Logs`: runtime and failure diagnostics.

The pane can be collapsed, but users often need it for setup and debugging.

## Other routes

- `/runs`: searchable run history,
- `/runs/:runName`: detailed run view,
- `/oidc/callback`: auth callback route,
- Google Drive OAuth callback route is handled separately by the app router.

## High-value facts for Codex

- The notebook workspace is the primary route and should be assumed first.
- The UI is stateful across refreshes because much of the configuration lives in
  browser storage.
- The side panel and bottom pane are not optional for advanced flows; they are
  core product surfaces.
