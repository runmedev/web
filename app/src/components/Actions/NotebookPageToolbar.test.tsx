import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import {
  notebookPages,
  resolvePage,
  DEFAULT_PAGE,
} from '../../lib/notebookPages'
import { NotebookPageToolbar } from './NotebookPageToolbar'

/** Two mounted editors share metadata and select pages independently. */
it('creates, opens, renames and reorders pages without changing the other editor selection', () => {
  const open = vi.fn()
  function Editors() {
    const [metadata, setMetadata] = useState<Record<string, string>>({})
    const [first, selectFirst] = useState<string>()
    const [second, selectSecond] = useState<string>()
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
      <>
        {[0, 1].map((i) => (
          <section key={i} aria-label={'Editor ' + i}>
            <NotebookPageToolbar
              data={data}
              pages={pages}
              defaultId={metadata[DEFAULT_PAGE]}
              current={resolvePage(
                i ? second : first,
                pages,
                metadata[DEFAULT_PAGE]
              )}
              select={i ? selectSecond : selectFirst}
              open={open}
            />
          </section>
        ))}
      </>
    )
  }
  render(<Editors />)
  const first = within(screen.getByRole('region', { name: 'Editor 0' }))
  const second = within(screen.getByRole('region', { name: 'Editor 1' }))
  fireEvent.click(first.getByText('New page'))
  fireEvent.change(first.getByLabelText('Page name'), {
    target: { value: 'Investigation' },
  })
  fireEvent.click(first.getByText('Save'))
  const selection = (scope: typeof first) =>
    (scope.getByLabelText('Page') as HTMLSelectElement).selectedOptions[0]?.text
  expect(selection(first)).toBe('Investigation')
  expect(selection(second)).toBe('Main')
  fireEvent.click(first.getByText('Open page in new tab'))
  expect(open).toHaveBeenCalledWith(
    (first.getByLabelText('Page') as HTMLSelectElement).value
  )
  fireEvent.click(first.getByText('Rename'))
  fireEvent.change(first.getByLabelText('Page name'), {
    target: { value: 'Postmortem' },
  })
  fireEvent.click(first.getByText('Save'))
  fireEvent.click(first.getByText('Move earlier'))
  expect(selection(first)).toBe('Postmortem')
  expect(selection(second)).toBe('Main')
})
