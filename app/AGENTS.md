# Agents.md

## Documentation and comments

- Functions and classes should have comments explaining what they do
- Comments should capture important design decisions
- Comments should explain how state is being managed via contexts and other react features
- Assume the person reading and reviewing the code is not very familiar with REACT and typescript and add
   comments to help explain the code.

- Add identifiers to "divs" to make it easier to debug layout and styling issues by making it easy to select elements in the chrome debug tools and then use the identifier
  to link them to the source code

## Notebook architecture (model/view + tabs)

- NotebookData is the in-memory model for a notebook. It owns the Notebook proto and emits change events on mutations.
- React views subscribe via `useNotebookSnapshot` (backed by `useSyncExternalStore`) and render from immutable snapshots to avoid tearing under concurrent rendering.
- Snapshots are clones; do not mutate them directly. Use NotebookData/CellData methods for updates.
- `loaded` distinguishes placeholder models (created before async load) from fully loaded notebooks; only `loadNotebook` flips it true.
- NotebookContext seeds `storeRef` and `openNotebooks` once from localStorage so models exist early; async loads populate existing models and emit.
- Tabs keep content mounted with `Tabs.Content forceMount` and `TabPanel` hides inactive tabs via `visibility`/`position` to preserve scroll/Monaco layout.
- Loading gates live inside `NotebookTabContent` and use snapshot.loaded to decide when to show content.

## Avoid Common Mistakes

In the the tree element use children property not render to set the render for each node.
Here is an example of correct code.

```tex
   <Tree
            data={treeNodes}
            openByDefault={true}
            width="100%"
            height={360}
            indent={20}
            children={renderNode}
            onToggle={handleToggle}
            onClick={() => setContextMenu(null)}
          />
```

## Review guidelines for app/

* Ensure code changes are consistent with the design, practices, and styles defined in `docs-dev/architecture.md`.
* Ensure that tests are properly updated to verify bug fixes and prevent regressions, including adding new tests where needed.
  * Ensure CUJs as defined in `docs-dev/cujs` are updated if necessary.
  * Ensure E2E tests and CUJs are in sync.
* Ensure artifacts uploaded by tests confirm that the tests are validating what they claim to test.

## Backend/Fake Implementation Policy

- Test backends and fake services must be implemented in Go.
- Do not add new Python/Node-based fake backend servers for browser integration tests or CUJs.
- If a TypeScript test harness needs to spin up a fake service, it should invoke a Go command (for example `go run ...`) rather than embedding the server in JavaScript.
- Shared fake backend binaries should live under the repo-root `testing/` directory.
