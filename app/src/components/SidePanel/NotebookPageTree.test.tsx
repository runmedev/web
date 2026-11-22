import { fireEvent, render, screen } from '@testing-library/react'
import { Theme } from '@radix-ui/themes'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { notebookPages, resolvePage } from '../../lib/notebookPages'
import { NotebookPageTree } from './NotebookPageTree'

it('adds and renames a page, nests its headings and reorders it by dragging its title', () => {
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
        current={resolvePage(first, pages)}
        open={(id, name) => {
          open(id, name)
          selectFirst(id)
        }}
        headings={(id) => <span>{id === first ? 'Timeline' : 'Overview'}</span>}
      />
    )
  }
  render(
    <Theme>
      <Editors />
    </Theme>
  )
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
  fireEvent.keyDown(screen.getByLabelText('Settings for Investigation'), {
    key: 'Enter',
  })
  expect(screen.queryByText('Set as default')).toBeNull()
  fireEvent.click(screen.getByText('Rename'))
  fireEvent.change(screen.getByLabelText('Page name'), {
    target: { value: 'Postmortem' },
  })
  fireEvent.click(screen.getByText('Save'))
  const title = screen.getByText('Postmortem', { selector: 'span' })
  expect(title.closest('button')?.draggable).toBe(true)
  fireEvent.contextMenu(title)
  expect(
    screen.getByRole('menu', { name: 'Settings for Postmortem' })
  ).toBeTruthy()
  expect(
    screen.getAllByRole('menuitem').map((item) => item.textContent)
  ).toEqual([
    'Rename',
    'Move earlier',
    'Move later',
    'Remove page and keep cells',
  ])
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  const target = screen.getByRole('button', { name: 'Main' })
  fireEvent.dragStart(title, { dataTransfer: { setData: vi.fn() } })
  fireEvent.dragOver(target)
  fireEvent.drop(target)
  expect(screen.getAllByRole('listitem')[0].textContent).toContain('Postmortem')
  fireEvent.dragStart(title, { dataTransfer: { setData: vi.fn() } })
  fireEvent(target, new MouseEvent('dragover', { bubbles: true, clientY: 10 }))
  fireEvent.drop(target)
  expect(screen.getAllByRole('listitem')[1].textContent).toContain('Postmortem')
  expect(open).toHaveBeenCalledTimes(1)
})
