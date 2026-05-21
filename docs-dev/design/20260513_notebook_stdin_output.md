# 2026-05-13: Notebook stdin and Output UX

## Status

Implemented on this branch. Ready to merge after review.

## Summary

Notebook code cells should not use raw terminal typing as the primary UX for
interactive stdin.

This change keeps the live `CellConsole` transcript for active runner-backed
runs, but replaces terminal-first stdin with an explicit submit-oriented input
composer. The user types a response into a dedicated field and submits it as
one write instead of streaming every keystroke into the terminal widget.

This fixes the main failure reported in
[#99](https://github.com/runmedev/web/issues/99):

- prompts without a trailing newline are currently invisible while the process
  waits for input
- notebook output can appear cut off because terminal rendering suppresses the
  normal stdout/stderr view and applies terminal scrollback limits
- notebook cells can render the same transcript twice as both a `CellConsole`
  and normal stdout/stderr output items

[#191](https://github.com/runmedev/web/pull/191) removed renderer callbacks
from notebook mutation paths. It did not change the notebook interaction model.
This document covers that follow-on work. It also overlaps with the broader
output-rendering cleanup tracked in
[#190](https://github.com/runmedev/web/issues/190).

## Problem

The current notebook cell experience mixes document rendering and terminal
emulation in a way that is hard to reason about and easy to break.

Before this change:

- `Actions.tsx` renders `CellConsole` when a cell has
  `StatefulRunmeTerminal` output or an active stream
- `ActionOutputItems` suppresses normal stdout/stderr blocks when terminal
  output is present
- `CellConsole` mounts `console-view` and forwards `terminal:stdin`
  keystrokes to the runner one chunk at a time
- both `CellConsole` and `bindStreamsToCell(...)` buffer trailing stdout until
  newline or process exit
- `CellConsole` sets terminal scrollback to `4000`

That creates four concrete problems.

### 1. Waiting-for-input is invisible

The issue report includes a prompt like:

```text
Xcode Command Line Tools is already installed.
Password:
```

`Password:` does not end with a newline. The current buffering logic keeps that
text in a pending buffer and does not render it until a newline arrives or the
process exits. If the process is waiting on stdin, the user sees no prompt and
cannot tell why execution stopped.

This is not a small rendering detail. It breaks the basic interaction loop for
stdin-driven execution.

### 2. Notebook output can appear cut off

Notebook output is supposed to be part of the document. Terminal scrollback is
not.

The current terminal path can hide or drop visible output in several ways:

- stdout/stderr document rendering is suppressed when terminal output is
  present
- `console-view` has a scrollback cap of `4000`
- terminal state is imperative UI state rather than a pure rendering of the
  notebook model

That means a notebook cell can have a fuller persisted transcript than the user
can actually see in the notebook UI.

### 3. The same transcript can render twice

The current rendering policy uses two different signals:

- `CellConsole` renders when the cell has terminal output or an active stream
- `ActionOutputItems` suppresses stdout/stderr only when the cell has a
  `StatefulRunmeTerminal` output marker

That split creates a duplication bug.

If a cell has an active stream but no terminal marker, the UI renders:

- a live `CellConsole`
- the same stdout/stderr as normal output items

This is likely the follow-on regression after #191. That change stopped seeding
terminal markers during mutation, but the output rendering policy still assumes
that terminal suppression is keyed off the marker.

The result is exactly the duplicated UI we now see:

- `Output 0 / Item 0 - mime=application/vnd.code.notebook.stdout`
- a console showing the same transcript

Notebook cells must choose one transcript presentation path per run. They
should not render both.

### 4. Character-at-a-time terminal input is the wrong notebook UX

Notebook cells are structured documents. They already separate source from
output. They should not behave like a remote PTY by default.

For notebook cells, the useful interaction is usually:

1. read the prompt
2. type a response
3. submit that response

The useful interaction is not:

1. focus a terminal widget
2. stream raw keystrokes
3. infer prompt state from cursor position and terminal paint state

The raw-terminal model also makes replay, testing, and automation harder than
necessary.

## Goals

- Make waiting for stdin obvious.
- Preserve complete notebook output without terminal scrollback loss.
- Use the notebook model as the source of truth for rendered output.
- Support ordinary line-oriented stdin for runner-backed notebook cells.
- Ensure each notebook transcript is rendered exactly once.
- Align notebook execution UX with the append-only, document-style direction
  already used elsewhere in the app.

## Non-Goals

- Full TTY emulation inside notebook cells.
- Support for curses or full-screen terminal apps in notebook cells.
- Jupyter `input_request` support in this change.
- Password masking without explicit backend signal.
- Replacing App Console or other dedicated terminal-like surfaces.

## Decision

We will use a submit-oriented stdin composer for notebook cells.

We will not use raw terminal typing as the primary notebook input UX.

We will keep `CellConsole` as the live transcript surface for active
runner-backed runs.

We will treat notebook outputs as the persisted source of truth after the run
completes.

We will ensure notebook output has a single presentation path per run.

In v1, we will show the stdin affordance for active stdin-capable runs. We will
not wait for a precise backend "blocked on stdin" signal before making input
available.

We will surface partial trailing stdout immediately instead of waiting for a
newline.

We will keep true terminal UX for App Console or a future dedicated terminal
surface, not for notebook cells.

## Why This Is The Right Boundary

Notebook cells and terminal sessions have different product contracts.

Notebook cells should provide:

- complete, replayable output
- stable input/output boundaries
- deterministic rerender from model state
- DOM structure that tests and automation can inspect directly

Terminal sessions should provide:

- raw keystroke streaming
- cursor-oriented rendering
- terminal scrollback semantics
- support for full-screen terminal apps

The current implementation tries to make notebook cells act like terminals.
That is the wrong abstraction boundary.

## Proposal

### 1. Replace notebook `CellConsole` input with an explicit stdin composer

When a notebook cell has an active runner stream, the output area renders:

- the live `CellConsole` transcript
- run status
- an input composer

The input composer is the only editable element for stdin.

Recommended v1 behavior:

- render a single-line text input
- render a `Send` button
- show the composer whenever the process is still running on the stdin-capable
  runner path
- pressing `Enter` submits the current value
- submission sends one `ExecuteRequest.inputData` write containing the entered
  text plus `\n`
- clear the composer after submit
- do not locally echo the submitted text; rely on the remote process to echo if
  that is part of its behavior

The composer can remain visible for any active interactive run. We do not need
perfect blocked-on-stdin detection in v1 to make the UX usable. The v1 state is
"stdin available while the run is active", not "stdin is definitely blocked
right now."

### 2. Render partial stdout immediately

Generic runner stdout should be written into the live console transcript as it
arrives.

We should not keep generic stdout in a hidden partial-line buffer waiting for a
newline. That buffering makes sense only for protocols that are actually
line-delimited control streams. It is wrong for terminal-like stdout where
unterminated prompts are meaningful UI.

This is the concrete fix for the missing `Password:` prompt.

### 3. Stop relying on terminal scrollback for notebook history

Notebook history should not depend on a stale terminal marker.

The merged behavior is:

- active runs render exactly one live transcript path via `CellConsole`
- normal stdout/stderr output items are suppressed only while that live stream
  is active
- after the run completes, the active stream is cleared and persisted output
  items become the notebook-visible history again

This fixes the duplicate-rendering bug and avoids keeping the cell stuck in a
false "still interactive" state after exit.

### 4. Keep Jupyter handling separate

Jupyter is already handled through a different path. Its `input_request` flow
is explicitly unsupported today.

We should keep that boundary clear:

- runner-backed shell-like cells get the new stdin composer
- Jupyter cells continue to reject `input_request` in v1

We should not mix Jupyter message parsing requirements into the generic runner
stdout path.

### 5. Treat terminal markers as compatibility hints, not as rendering truth

`StatefulRunmeTerminal` should not force notebook cells into xterm rendering.

Merged behavior:

- continue to read existing terminal markers so older notebooks still render in
  a compatible way
- use the marker only as a compatibility hint for legacy terminal-backed cells
- do not rely on new runs seeding fresh terminal markers
- determine live-vs-persisted rendering from active run state and normal output
  items instead

This aligns with the direction already described in #190.

## Implementation Plan

### Merged change

1. Replace notebook-cell terminal input with a dedicated React stdin composer.
2. Show that composer for active stdin-capable runs, even without a precise
   `stdinRequested` protocol event.
3. Route submitted input through `ExecuteRequest.inputData`.
4. Keep the live transcript in `CellConsole` while the run is active.
5. Remove newline-delayed buffering from the generic runner stdout path.
6. Remove the split policy where active-stream cells render `CellConsole` while
   stdout/stderr suppression still depends on terminal markers.
7. Clear the cached active stream on exit/error so the cell falls back to
   persisted output items after completion.
8. Ensure notebook cells choose one transcript renderer, not both.
9. Keep Jupyter behavior unchanged.

This is the change we intend to merge for #99.

### Future work to consider

The merged change makes stdin usable. It does not make it precise.

The remaining gap is prompt semantics. The UI still cannot know:

- whether the process is truly blocked on stdin
- whether the input should be masked
- whether the input is line-oriented or raw

If Runme can surface that information, we should add an explicit event or state
shape such as:

```ts
type StdinRequest = {
  active: boolean;
  prompt?: string;
  echo?: boolean;
  mode?: "line" | "raw";
};
```

That would let the UI show:

- `Waiting for input`
- a masked field when `echo === false`
- better affordances for non-default submission behavior

This is useful future work, but it is not required for the merged change.

## Affected Areas

The change will primarily affect:

- `app/src/components/Actions/Actions.tsx`
- `app/src/components/Actions/CellConsole.tsx`
- `app/src/lib/notebookData.ts`

Expected structural changes:

- move notebook stdin UI into a React component adjacent to `CellConsole`
- limit generic runner stream handling to live transcript updates plus normal
  persisted outputs
- keep any protocol-specific parsing scoped to the protocol that needs it

## Password Prompts

Password prompts are a special case.

The example in #99 is a password prompt. A browser text input should not guess
whether input needs masking. The runtime must tell us.

Therefore:

- v1 should support visible line input only
- notebook cells remain a poor place for secret-entry workflows until the
  runtime can signal `echo: false`
- if secret entry matters before then, we should direct users to a true
  terminal surface

This limitation should be explicit in the shipped UX and in tests.

## Alternatives Considered

### Keep `console-view` and only flush partial stdout earlier

This fixes the missing prompt, but it does not fix the architectural problem.

We would still have:

- terminal scrollback limits in notebook history
- output rendering split between notebook state and xterm state
- raw keystroke stdin as the primary notebook interaction model

This is not enough.

### Keep raw terminal input but add a “waiting” banner

A banner helps a little, but the user still has to interact with a terminal
widget inside a notebook cell.

That does not improve replay, testing, automation, or output completeness.

### Route interactive notebook cells into a separate terminal pane

This is cleaner than embedding xterm in the cell, but it is heavier than we
need for ordinary prompts such as `y/n` or single-line input.

It is a reasonable future option for true terminal workflows. It is not the
best v1 fix for #99.

## Testing

We should add a focused interactive test notebook and browser coverage.

Required cases:

1. Prompt without trailing newline:

```bash
printf "Continue? [y/N] "
read -r answer
printf "\nanswer=%s\n" "$answer"
```

Expected behavior:

- `Continue? [y/N] ` is visible before input is sent
- user can submit `y`
- final output includes `answer=y`

2. Long output larger than terminal scrollback:

```bash
for i in $(seq 1 5005); do
  printf "Line %04d\n" "$i"
done
```

Expected behavior:

- the notebook view shows the full persisted transcript after completion
- reload preserves the full transcript

3. Interactive cell rerun:

- rerun clears prior live output according to current semantics
- prompt still appears correctly on the new run

4. Legacy terminal marker notebook:

- older cells with `StatefulRunmeTerminal` still render output correctly

5. Jupyter `input_request`:

- current unsupported message remains explicit

## Open Questions

- Should the v1 stdin composer include a `Send EOF` action?
- Should we allow multi-line input submission, or keep notebook stdin strictly
  line-oriented in v1?
- Should the composer stay visible for the full duration of an active run, or
  only after we have backend `stdinRequested` metadata?
- Should we eventually stop rendering legacy `StatefulRunmeTerminal` output in
  notebook cells once migration coverage is good enough?

## Recommendation

For notebook cells, we should model stdin as explicit submitted input, not as a
terminal keystroke stream.

That gives us the right UX for notebook documents, fixes the hidden-prompt bug,
and removes terminal scrollback as a source of apparent output truncation.
