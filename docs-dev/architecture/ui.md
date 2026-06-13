# UI Action Runtime Pattern

## Principle

Any meaningful UI action should map to a runtime function that can be invoked
from the App Console and through WebMCP/code mode.

This keeps human workflows and agent workflows equivalent:

- A person can click a button.
- An agent can call the same behavior programmatically.
- Tests can verify the behavior without depending only on pointer automation.

## Required Shape

For a user-visible action:

1. Put the behavior in a domain module, not inside the React event handler.
2. Make the React control call that domain function.
3. Expose the same domain function through an App Console namespace when the
   action is useful for automation.
4. Add the WebMCP/code-mode bridge method when agents need the action from the
   sandbox.
5. Document the command in the namespace `help()` output.
6. Add direct unit coverage for the domain function and runtime wrapper.

React components should own presentation state such as loading, disabled state,
toasts, and layout. They should not be the only place where business behavior is
implemented.

## App Console Contract

Runtime APIs should be:

- explicit about targets,
- safe to call with the current selected notebook when that is natural,
- idempotent where repeated UI clicks are plausible,
- backed by the same persistence and validation path as the UI action.

Prefer object arguments for actions that may grow:

```js
await namespace.action({
  target: { handle: doc.handle },
  option: true,
})
```

## WebMCP Bridge Contract

When a command must be available to agents from code mode:

- add it to the App Console/global runtime namespace,
- add a corresponding host method in the sandbox bridge,
- add it to the sandbox allowlist,
- include it in bridge help text.

The host method should call the same runtime API object used by the browser
console. Do not create a separate implementation for WebMCP.

## Example: Conflict Resolution

The notebook conflict diff UI has an **Insert ->** button for upstream cells
that are missing locally.

The button calls the conflict restore domain function. The same behavior is
available from App Console and WebMCP:

```js
const doc = await notebooks.get()
await notebookDiff.restoreDeletedCell({
  target: { handle: doc.handle },
  refId: 'upstream-cell-ref-id',
})
```

To resolve all missing upstream cells:

```js
await notebookDiff.restoreAllDeletedCells({
  target: { handle: doc.handle },
})
```

This pattern lets an agent handle a request such as:

> Insert all missing upstream cells into the local copy.

without scraping the UI or synthesizing clicks. The UI and agent path both use
the same conflict restore logic, including local edit flushing and diff refresh.
