import { useState, type ReactNode } from 'react'
import {
  ChevronRightIcon,
  DocumentIcon,
  PlusIcon,
  EllipsisHorizontalIcon,
  Bars3Icon,
} from '@heroicons/react/20/solid'
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

/** Page records own their names and positions. Expansion and drag state belong to this outline. */
export function NotebookPageTree({
  pages,
  current,
  defaultId,
  data,
  open,
  headings,
}: {
  pages: NotebookPage[]
  current?: string
  defaultId?: string
  data?: Pick<
    NotebookData,
    'setMetadataProperty' | 'setMetadataProperties'
  > | null
  open: (id: string, name: string) => void
  headings: (id?: string) => ReactNode
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<{
    id?: string
    rename?: boolean
    name: string
  } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null)
  const rows = pages.length ? pages : [{ id: '', name: 'Main' }]
  function move(id: string, target: string, after: boolean) {
    if (id === target) return
    const rest = pages.filter((p) => p.id !== id)
    const index = rest.findIndex((p) => p.id === target)
    if (index < 0) return
    const at = index + Number(after)
    data?.setMetadataProperty(
      pagePositionKey(id),
      pagePosition(rest[at - 1], rest[at])
    )
  }
  return (
    <>
      <header className="flex items-center justify-between border-b border-nb-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-nb-text-muted">
          Outline
        </h2>
        {data && (
          <button
            className="icon-btn"
            aria-label="Add page"
            title="Add page"
            onClick={() => {
              setMenu(null)
              setEdit({ name: '' })
            }}
          >
            <PlusIcon className="h-4 w-4" />
          </button>
        )}
      </header>
      {edit && (
        <form
          className="flex flex-wrap gap-2 p-2 text-sm"
          onSubmit={(event) => {
            event.preventDefault()
            if (!edit.name.trim() || !data) return
            if (edit.id)
              data.setMetadataProperty(pageNameKey(edit.id), edit.name.trim())
            else {
              const { id, changes } = createPageProperties(
                pages,
                edit.name,
                !edit.rename
              )
              data.setMetadataProperties(changes)
              open(id, edit.name.trim())
            }
            setEdit(null)
          }}
        >
          <input
            autoFocus
            aria-label="Page name"
            placeholder="Page name"
            className="w-full rounded border border-nb-border px-2 py-1"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
          <button disabled={!edit.name.trim()}>Save</button>
          <button type="button" onClick={() => setEdit(null)}>
            Cancel
          </button>
        </form>
      )}
      <nav
        aria-label="Notebook outline"
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        <ul>
          {rows.map(({ id, name }, index) => (
            <li key={id}>
              <div
                className={
                  'flex items-center gap-1 rounded px-1 py-1 border-y-2 ' +
                  (over?.id === id
                    ? over.after
                      ? 'border-t-transparent border-b-nb-accent'
                      : 'border-t-nb-accent border-b-transparent'
                    : 'border-transparent') +
                  ((current ?? '') === id ? ' bg-nb-surface-2' : '')
                }
                onDragOver={(e) => {
                  if (!drag || drag === id) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  setOver({ id, after: e.clientY > r.top + r.height / 2 })
                }}
                onDrop={(e) => {
                  if (!drag || !over || over.id !== id) return
                  e.preventDefault()
                  move(drag, id, over.after)
                  setDrag(null)
                  setOver(null)
                }}
              >
                <button
                  aria-label={
                    (collapsed.has(id) ? 'Expand ' : 'Collapse ') + name
                  }
                  aria-expanded={!collapsed.has(id)}
                  onClick={() =>
                    setCollapsed((old) => {
                      const next = new Set(old)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }
                >
                  <ChevronRightIcon
                    className={
                      'h-4 w-4 ' + (collapsed.has(id) ? '' : 'rotate-90')
                    }
                  />
                </button>
                <button
                  aria-current={(current ?? '') === id ? 'page' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium"
                  onClick={() => open(id, name)}
                >
                  <DocumentIcon className="h-4 w-4 shrink-0 text-nb-text-faint" />
                  <span className="truncate">{name}</span>
                </button>
                {data && (
                  <>
                    {id && (
                      <span
                        draggable
                        title={'Drag to reorder ' + name}
                        className="cursor-grab text-nb-text-faint"
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', id)
                          e.dataTransfer.effectAllowed = 'move'
                          setDrag(id)
                        }}
                        onDragEnd={() => {
                          setDrag(null)
                          setOver(null)
                        }}
                      >
                        <Bars3Icon className="h-4 w-4" />
                      </span>
                    )}
                    <button
                      aria-label={'Settings for ' + name}
                      aria-expanded={menu === id}
                      onClick={() => setMenu(menu === id ? null : id)}
                    >
                      <EllipsisHorizontalIcon className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
              {menu === id && data && (
                <div
                  className="ml-6 flex flex-col items-start gap-1 border-l border-nb-border px-2 py-1 text-xs"
                  onClick={() => setMenu(null)}
                >
                  <button onClick={() => setEdit({ id, rename: true, name })}>
                    Rename
                  </button>
                  {id && (
                    <>
                      <button
                        disabled={!index}
                        onClick={() => move(id, rows[index - 1].id, false)}
                      >
                        Move earlier
                      </button>
                      <button
                        disabled={index === rows.length - 1}
                        onClick={() => move(id, rows[index + 1].id, true)}
                      >
                        Move later
                      </button>
                      <button
                        disabled={id === defaultId}
                        onClick={() =>
                          data.setMetadataProperty(DEFAULT_PAGE, id)
                        }
                      >
                        Set as default
                      </button>
                      <button
                        onClick={() =>
                          data.setMetadataProperty(pageDeletedKey(id), 'true')
                        }
                      >
                        Remove page and keep cells
                      </button>
                    </>
                  )}
                </div>
              )}
              {!collapsed.has(id) && (
                <div className="ml-3 border-l border-nb-border pl-2">
                  {headings(id || undefined)}
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
