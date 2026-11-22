import { ContextMenu, DropdownMenu } from '@radix-ui/themes'
import type { NotebookData } from '../lib/notebookData'
import {
  pagePositionKey,
  pagePosition,
  pageDeletedKey,
  type NotebookPage,
} from '../lib/notebookPages'

/** Allocate a position between the target's neighbors in the shared page order. */
export function moveNotebookPage(
  data: Pick<NotebookData, 'setMetadataProperty'>,
  pages: NotebookPage[],
  id: string,
  target: string,
  after: boolean
) {
  if (id === target) return
  const rest = pages.filter((p) => p.id !== id)
  const index = rest.findIndex((p) => p.id === target)
  if (index < 0) return
  const at = index + Number(after)
  data.setMetadataProperty(
    pagePositionKey(id),
    pagePosition(rest[at - 1], rest[at])
  )
}

/** Outline and tab menus act on the page ID supplied by their trigger. */
export function NotebookPageMenuItems({
  contextMenu,
  pages,
  id,
  data,
  rename,
}: {
  contextMenu?: boolean
  pages: NotebookPage[]
  id: string
  data: Pick<NotebookData, 'setMetadataProperty'>
  rename: () => void
}) {
  const Item = contextMenu ? ContextMenu.Item : DropdownMenu.Item
  const index = pages.findIndex((p) => p.id === id)
  return (
    <>
      <Item onSelect={rename}>Rename</Item>
      {id && (
        <>
          <Item
            disabled={!index}
            onSelect={() =>
              moveNotebookPage(data, pages, id, pages[index - 1].id, false)
            }
          >
            Move earlier
          </Item>
          <Item
            disabled={index === pages.length - 1}
            onSelect={() =>
              moveNotebookPage(data, pages, id, pages[index + 1].id, true)
            }
          >
            Move later
          </Item>
          <Item
            onSelect={() =>
              data.setMetadataProperty(pageDeletedKey(id), 'true')
            }
          >
            Remove page and keep cells
          </Item>
        </>
      )}
    </>
  )
}
