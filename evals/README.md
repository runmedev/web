# Codex Agent evals for Runme Web

This directory contains a small external eval harness for Runme Web. It launches a Codex Agent build, creates a task without sending a throwaway turn, prepares a Drive-backed Runme tab through the leased-tab eval API, submits the actual prompt, and verifies the resulting task and browser state.

The three cases in `cases.json` were ported from the Runme cases in openai/openai#1087983:

- read the first cell of an already-open Drive notebook;
- find and open `eval_read` by name; and
- append a Markdown cell to a per-trial copy of a Drive notebook.

The repository does not import OpenAI monorepo Python packages, bundle internal marketplace plugins, or contain OpenAI credentials. The cases use the Agent build's bundled Browser plugin and Runme's site-provided WebMCP tools. The Codex Apps checkout and Google service-account file are explicit runtime inputs.

## Setup

Create a virtual environment and install the small driver dependency set:

```bash
python3 -m venv .venv
.venv/bin/pip install -r evals/requirements.txt
```

The service account must be able to read the source notebooks and create/delete a copy for the write case. Codex authentication defaults to `~/.codex/auth.json` and is copied into an isolated temporary Codex home for each run.

## Run

From the `runmedev/web` repository root:

```bash
.venv/bin/python evals/run.py \
  --codex-apps-root /path/to/openai/codex/codex-apps \
  --service-account-file /path/to/service-account.json
```

Run one case with `--case google-drive-first-cell`. Add `--keep-runtime` to retain the isolated Codex logs and profile after the run.

The harness exits nonzero if setup fails, Codex does not claim the prepared Runme tab, an unexpected tab appears, the task fails, expected answer evidence is absent, or expected page state is not visible after the turn.

## Agent build command

The harness starts Codex from the supplied checkout with:

```bash
pnpm run app --flavor agent --playwright ...
```

The remaining arguments point at isolated Codex home, SQLite, and browser-profile directories created for the run. The harness uses the checkout's normal dev-app metadata path and refuses to launch if that worktree already has a live Codex app. Pass `--attach-cdp-url` to exercise the cases against an Agent build that is already running instead.
