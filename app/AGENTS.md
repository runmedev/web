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
