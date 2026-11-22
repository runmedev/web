import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import {
  notebookPages,
  resolvePage,
  DEFAULT_PAGE,
} from '../../lib/notebookPages'
import { NotebookPageTree } from './NotebookPageTree'

it('adds and renames a page, nests its headings and reorders it by drag handle', () => {
  const open = vi.fn()
  function Editors() {
    const [metadata, setMetadata] = useState<Record<string, string>>({})
    const [first, selectFirst] = useState<string>()

    const pages = notebookPages(metadata)
    const data = {
      setMetadataProperties: (changes: Record<string, string | null>) =>
        setMetadata((old) =>
          Object.fromEntries(
            Object.entries({ ...old, ...changes }).filter(
              (entry): entry is [string, string] => entry[1] !== null
            )
          )
        ),
      setMetadataProperty: (key: string, value: string) =>
        setMetadata((old) => ({ ...old, [key]: value })),
    }
    return (
      <NotebookPageTree
        data={data}
        pages={pages}
        defaultId={metadata[DEFAULT_PAGE]}
        current={resolvePage(first, pages, metadata[DEFAULT_PAGE])}
        open={(id, name) => {
          open(id, name)
          selectFirst(id)
        }}
        headings={(id) => <span>{id === first ? 'Timeline' : 'Overview'}</span>}
      />
    )
  }
  render(<Editors />)
  fireEvent.click(screen.getByRole('button', { name: 'Add page' }))
  fireEvent.change(screen.getByLabelText('Page name'), {
    target: { value: 'Investigation' },
  })
  fireEvent.click(screen.getByText('Save'))
  expect(open).toHaveBeenCalledWith(expect.any(String), 'Investigation')
  fireEvent.click(screen.getByLabelText('Collapse Investigation'))
  expect(screen.queryByText('Timeline')).toBeNull()
  fireEvent.click(screen.getByLabelText('Expand Investigation'))
  expect(screen.getByText('Timeline')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Settings for Investigation'))
  fireEvent.click(screen.getByText('Rename'))
  fireEvent.change(screen.getByLabelText('Page name'), {
    target: { value: 'Postmortem' },
  })
  fireEvent.click(screen.getByText('Save'))
  const handle = screen.getByTitle('Drag to reorder Postmortem')
  const target = screen.getByRole('button', { name: 'Main', exact: true })
  fireEvent.dragStart(handle, { dataTransfer: { setData: vi.fn() } })
  fireEvent.dragOver(target)
  fireEvent.drop(target)
  expect(screen.getAllByRole('listitem')[0].textContent).toContain('Postmortem')
})
