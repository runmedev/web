import { useState } from 'react'
import {
  DEFAULT_PAGE,
  createPageProperties,
  pageNameKey,
  pageDeletedKey,
  pagePositionKey,
  pagePosition,
  type NotebookPage,
} from '../../lib/notebookPages'
import type { NotebookData } from '../../lib/notebookData'

/** The page selector is local to an editor. Only explicit edits touch notebook data. */
export function NotebookPageToolbar({
  pages,
  current,
  defaultId,
  data,
  select,
  open,
}: {
  pages: NotebookPage[]
  current?: string
  defaultId?: string
  data: Pick<
    NotebookData,
    'setMetadataProperty' | 'setMetadataProperties'
  > | null
  select: (id: string) => void
  open: (id: string) => void
}) {
  const [edit, setEdit] = useState<'new' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const index = pages.findIndex((p) => p.id === current)
  const page = pages[index]
  function submit() {
    if (!name.trim() || !data) return
    if (edit === 'rename' && page) {
      data.setMetadataProperty(pageNameKey(page.id), name.trim())
    } else {
      const { id, changes } = createPageProperties(pages, name, edit === 'new')
      data.setMetadataProperties(changes)
      select(id)
    }
    setEdit(null)
  }
  return (
    <nav
      aria-label="Notebook pages"
      className="flex flex-wrap items-center gap-3 border-b border-nb-border pb-2 mb-3 text-xs"
    >
      <label>
        Page{' '}
        <select
          aria-label="Page"
          value={current ?? ''}
          onChange={(e) => select(e.target.value)}
        >
          {!pages.length && <option value="">Main</option>}
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {page && (
        <button onClick={() => open(page.id)}>Open page in new tab</button>
      )}
      {data && (
        <>
          <button
            onClick={() => {
              setName('')
              setEdit('new')
            }}
          >
            New page
          </button>
          <details>
            <summary>Page settings</summary>
            <div className="flex gap-3 py-2">
              <button
                onClick={() => {
                  setName(page?.name ?? 'Main')
                  setEdit('rename')
                }}
              >
                Rename
              </button>
              {page && (
                <>
                  <button
                    disabled={index === 0}
                    onClick={() =>
                      data.setMetadataProperty(
                        pagePositionKey(page.id),
                        pagePosition(pages[index - 2], pages[index - 1])
                      )
                    }
                  >
                    Move earlier
                  </button>
                  <button
                    disabled={index === pages.length - 1}
                    onClick={() =>
                      data.setMetadataProperty(
                        pagePositionKey(page.id),
                        pagePosition(pages[index + 1], pages[index + 2])
                      )
                    }
                  >
                    Move later
                  </button>
                  <button
                    disabled={page.id === defaultId}
                    onClick={() =>
                      data.setMetadataProperty(DEFAULT_PAGE, page.id)
                    }
                  >
                    Set as default
                  </button>
                  <button
                    onClick={() =>
                      data.setMetadataProperties({
                        [pageDeletedKey(page.id)]: 'true',
                      })
                    }
                  >
                    Remove page and keep cells
                  </button>
                </>
              )}
            </div>
          </details>
        </>
      )}
      {edit && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex gap-2"
        >
          <input
            autoFocus
            aria-label="Page name"
            placeholder="Page name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={!name.trim()}>Save</button>
          <button type="button" onClick={() => setEdit(null)}>
            Cancel
          </button>
        </form>
      )}
    </nav>
  )
}
