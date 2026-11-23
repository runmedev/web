// @vitest-environment jsdom
import { Theme } from '@radix-ui/themes'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { driveLinkCoordinator } from '../../lib/driveLinkCoordinator'
import { getNotebookDataController } from '../../lib/notebookDataController'
import { appState } from '../../lib/runtime/AppState'
import OpenNotebookLink from './OpenNotebookLink'

describe('Open notebook link', () => {
  it.each(['metaKey', 'ctrlKey'])(
    'opens with %s+O and dismisses with Escape',
    async (modifier) => {
      render(
        <Theme>
          <OpenNotebookLink />
        </Theme>
      )
      const unhandled = fireEvent.keyDown(window, {
        key: 'o',
        [modifier]: true,
      })
      expect(unhandled).toBe(false)
      const input = screen.getByRole('combobox', {
        name: 'Notebook name or link',
      })
      await waitFor(() => expect(document.activeElement).toBe(input))
      fireEvent.keyDown(input, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
  )

  it.each([true, false])(
    'only bypasses Drive review for an open tab (open=%s)',
    async (isOpen) => {
      const uri = 'local://file/mirror'
      const drive =
        'https://drive.google.com/file/d/test/view?resourcekey=shared'
      const openTabs = vi
        .spyOn(getNotebookDataController(), 'getOpenNotebooks')
        .mockReturnValue([
          {
            uri: isOpen ? uri : 'local://file/other',
            requestedUri: drive,
            state: 'loaded',
            name: 'Notes',
          },
        ])
      const focus = vi
        .spyOn(appState, 'focusNotebook')
        .mockResolvedValue(undefined)
      const enqueue = vi
        .spyOn(driveLinkCoordinator, 'enqueue')
        .mockResolvedValue(undefined)
      const previous = appState.localNotebooks
      appState.setLocalNotebooks({
        files: {
          where: () => ({
            anyOf: () => ({ first: async () => ({ id: uri }) }),
          }),
        },
      } as unknown as NonNullable<typeof previous>)
      try {
        render(
          <Theme>
            <OpenNotebookLink />
          </Theme>
        )
        fireEvent.click(
          screen.getByRole('button', { name: 'Open notebook' })
        )
        fireEvent.change(screen.getByRole('combobox'), {
          target: { value: drive },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Open' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        if (isOpen) {
          expect(focus).toHaveBeenCalledWith(uri)
          expect(enqueue).not.toHaveBeenCalled()
        } else {
          expect(enqueue).toHaveBeenCalledWith(drive)
          expect(focus).not.toHaveBeenCalled()
        }
      } finally {
        appState.setLocalNotebooks(previous)
        openTabs.mockRestore()
        focus.mockRestore()
        enqueue.mockRestore()
      }
    }
  )

  it.each(['keyboard', 'click'])(
    'finds names inside collapsed folders and opens the chosen %s match',
    async (method) => {
      const root = 'local://folder/root'
      const nested = 'local://folder/ops'
      const names = [
        'error_investigator.runme',
        'error_report.ipynb',
        '[ops] alerts.runme',
      ]
      const files = names.map((_, i) => 'local://file/' + i)
      const roots = vi
        .spyOn(appState, 'getWorkspaceItems')
        .mockReturnValue([root, nested])
      const open = vi
        .spyOn(appState, 'openNotebook')
        .mockResolvedValue(undefined)
      const previous = appState.localNotebooks
      appState.setLocalNotebooks({
        getMetadata: async (uri: string) => {
          if (uri === root)
            return { uri, name: 'Explorer', type: 'folder', children: [nested] }
          if (uri === nested)
            return { uri, name: 'Ops', type: 'folder', children: files }
          return {
            uri,
            name: names[files.indexOf(uri)],
            type: 'file',
            children: [],
          }
        },
      } as unknown as NonNullable<typeof previous>)
      try {
        render(
          <Theme>
            <OpenNotebookLink />
          </Theme>
        )
        fireEvent.click(
          screen.getByRole('button', { name: 'Open notebook' })
        )
        const field = screen.getByRole('combobox')
        fireEvent.change(field, { target: { value: '[ops]' } })
        await screen.findByRole('option', { name: /alerts.runme/ })
        fireEvent.change(field, { target: { value: 'ERROR' } })
        await screen.findByRole('option', { name: /error_investigator.runme/ })
        expect(screen.getAllByRole('option')).toHaveLength(2)
        if (method === 'keyboard') {
          fireEvent.keyDown(field, { key: 'ArrowDown' })
          expect(
            screen.getByRole('option', { selected: true }).textContent
          ).toContain('error_report')
          fireEvent.submit(field.closest('form')!)
          expect(open).toHaveBeenCalledWith(files[1])
        } else {
          fireEvent.change(field, { target: { value: 'errinv' } })
          fireEvent.click(
            screen.getByRole('option', { name: /error_investigator.runme/ })
          )
          expect(open).toHaveBeenCalledWith(files[0])
        }
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      } finally {
        appState.setLocalNotebooks(previous)
        roots.mockRestore()
        open.mockRestore()
      }
    }
  )

  it('keeps invalid input editable and opens a corrected foreign-host link in place', async () => {
    const enqueue = vi
      .spyOn(driveLinkCoordinator, 'enqueue')
      .mockResolvedValue(undefined)
    render(
      <Theme>
        <OpenNotebookLink />
      </Theme>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open notebook' }))
    const input = screen.getByRole('combobox')
    fireEvent.change(input, {
      target: { value: 'https://example.com/unrelated' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    const drive = 'https://drive.google.com/file/d/notebook/view'
    fireEvent.change(input, {
      target: {
        value:
          '[Notes](https://old.example/?doc=' + encodeURIComponent(drive) + ')',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(enqueue).toHaveBeenCalledWith(drive)
    enqueue.mockRestore()
  })
})
