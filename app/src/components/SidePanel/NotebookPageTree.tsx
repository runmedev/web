import { useRef, useState, type ReactNode } from 'react'
import { DropdownMenu } from '@radix-ui/themes'
import {
  ChevronRightIcon,
  DocumentIcon,
  PlusIcon,
  EllipsisHorizontalIcon,
} from '@heroicons/react/20/solid'
import {
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
  data,
  open,
  headings,
}: {
  pages: NotebookPage[]
  current?: string
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
  const nameInput = useRef<HTMLInputElement>(null)
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
  const nameForm = edit && (
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
        ref={nameInput}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setEdit(null)
          }
        }}
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
  )
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
      {!edit?.rename && nameForm}
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
                onContextMenu={(event) => {
                  if (!data) return
                  event.preventDefault()
                  setMenu(id)
                }}
                onDragStart={(e) => {
                  if (!data || !id) return
                  e.dataTransfer.setData('text/plain', id)
                  e.dataTransfer.effectAllowed = 'move'
                  setDrag(id)
                }}
                onDragEnd={() => {
                  setDrag(null)
                  setOver(null)
                }}
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
                {edit?.rename && edit.id === id ? (
                  nameForm
                ) : (
                  <button
                    draggable={Boolean(data && id)}
                    title={data && id ? 'Drag to reorder ' + name : undefined}
                    aria-current={(current ?? '') === id ? 'page' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium [&[draggable=true]]:cursor-grab [&[draggable=true]]:select-none [&[draggable=true]]:active:cursor-grabbing"
                    onClick={() => open(id, name)}
                  >
                    <DocumentIcon className="pointer-events-none h-4 w-4 shrink-0 text-nb-text-faint" />
                    <span className="truncate">{name}</span>
                  </button>
                )}
                {data && (
                  <DropdownMenu.Root
                    open={menu === id}
                    onOpenChange={(isOpen) => setMenu(isOpen ? id : null)}
                  >
                    <DropdownMenu.Trigger>
                      <button aria-label={'Settings for ' + name}>
                        <EllipsisHorizontalIcon className="h-4 w-4" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                      align="end"
                      size="1"
                      onCloseAutoFocus={(event) => {
                        if (nameInput.current) {
                          event.preventDefault()
                          nameInput.current.focus()
                        }
                      }}
                    >
                      <DropdownMenu.Item
                        onSelect={() => setEdit({ id, rename: true, name })}
                      >
                        Rename
                      </DropdownMenu.Item>
                      {id && (
                        <>
                          <DropdownMenu.Item
                            disabled={!index}
                            onSelect={() => move(id, rows[index - 1].id, false)}
                          >
                            Move earlier
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            disabled={index === rows.length - 1}
                            onSelect={() => move(id, rows[index + 1].id, true)}
                          >
                            Move later
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            onSelect={() =>
                              data.setMetadataProperty(
                                pageDeletedKey(id),
                                'true'
                              )
                            }
                          >
                            Remove page and keep cells
                          </DropdownMenu.Item>
                        </>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                )}
              </div>
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
