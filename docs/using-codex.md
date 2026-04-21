# Using Codex

## Purpose

This page explains how Codex fits into Runme Web and clarifies a few terms that
show up in the UI and App Console.

## What Codex means in Runme Web

Runme Web can route AI interactions through Codex-backed harnesses.

Today that usually means one of:

- `codex`: a remote Codex app-server
- `codex-wasm`: a browser-hosted Codex runtime

In both cases, Runme uses Codex as the agent runtime and layers Runme-specific
notebook and browser capabilities on top.

## What Is A Project

In Runme Web, a `project` is a Runme concept, not a first-class Codex
app-server concept.

A project is a named bundle of defaults that Runme uses when it creates or
resumes Codex threads.

Typical project fields include:

- `cwd`
- `model`
- `approvalPolicy`
- `sandboxPolicy`
- `personality`
- optional writable roots or workspace metadata

You can think of a project as:

- "the default Codex environment for this workspace or notebook context"

not as:

- "an object stored by Codex app-server"

## Why Runme Has Projects

Codex threads need runtime configuration such as current working directory,
model, and approval behavior.

Runme groups those settings into a project so the UI can:

- switch between workspaces more easily,
- keep consistent defaults for a notebook or repo,
- create new threads with the right `cwd` and policies.

When you select a project in Runme, you are selecting the configuration bundle
that will be used for future thread startup or resume operations.

## Relationship Between Project And Thread

The simplest mental model is:

- project = default settings
- thread = a Codex conversation

Runme applies the selected project's defaults when it starts or resumes a
thread. After that, the thread is the active conversation unit.

So a project is not the conversation itself. It is the configuration context
for conversations.

## Practical Consequence

If you change projects, new or resumed Codex threads may use a different:

- working directory,
- model,
- approval behavior,
- sandbox behavior.

That is why project selection matters even though the Codex app-server API is
primarily thread- and turn-oriented.

## App Console Commands

Useful commands:

```js
app.codex.project.list()
app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)
app.codex.project.setDefault(projectId)
```

These commands manage Runme's local project definitions.
