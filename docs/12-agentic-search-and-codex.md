# Agentic Search And Codex

## Purpose

Runme Web supports Codex-related workflows in two distinct modes. Keep them
separate when choosing instructions, tools, and troubleshooting steps.

## Mode 1: Runme AI Chat Panel

In this mode, the user is inside Runme Web and talks to Codex through the
Runme `AI Chat` panel.

Use this mode when the user wants notebook-aware help from the Runme UI:

- ask questions about the current notebook,
- ask the assistant to add or update cells,
- use Runme's configured chat harness and project settings.

Read [codex-chat-panel.md](codex-chat-panel.md) for details.

## Mode 2: External Codex Through Chrome And WebMCP

In this mode, the user is chatting with Codex in the Codex desktop app, and
that desktop conversation controls or inspects Runme through the user's Chrome
browser and Runme's WebMCP tools.

Use this mode when Codex needs to:

- choose a specific Runme Chrome tab,
- verify the tab's Runme session id,
- inspect or mutate notebooks through WebMCP/AppKernel,
- coordinate multiple Codex conversations across multiple Runme tabs.

Read [codex-chrome-webmcp.md](codex-chrome-webmcp.md) for details.

## Choosing The Right Mode

Use the AI Chat panel mode when the user is asking from inside Runme Web.

Use Chrome/WebMCP mode when the user is asking the Codex desktop app to operate
a Runme tab.

The most common mistake is to mix these two paths. The chat panel path does not
need Chrome tab claiming. The Chrome/WebMCP path must verify the target tab
before reading or mutating notebook state.

## High-value Facts For Codex

- "Codex in Runme" can mean either in-app chat or external browser control.
- Ask which mode the user means if the request is ambiguous.
- For tab-specific external control, use `?session=<session-id>` and verify
  with `await app.getSessionID()`.
- For in-app chat behavior, inspect harness and project configuration from the
  App Console.
