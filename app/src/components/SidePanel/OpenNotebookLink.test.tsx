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
      const input = screen.getByRole('textbox', { name: 'Notebook link' })
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
          where: () => ({ anyOf: () => ({ primaryKeys: async () => [uri] }) }),
        },
      } as unknown as NonNullable<typeof previous>)
      try {
        render(
          <Theme>
            <OpenNotebookLink />
          </Theme>
        )
        fireEvent.click(
          screen.getByRole('button', { name: 'Open notebook link' })
        )
        fireEvent.change(screen.getByRole('textbox'), {
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

  it('keeps invalid input editable and opens a corrected foreign-host link in place', async () => {
    const enqueue = vi
      .spyOn(driveLinkCoordinator, 'enqueue')
      .mockResolvedValue(undefined)
    render(
      <Theme>
        <OpenNotebookLink />
      </Theme>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open notebook link' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'unrelated text' } })
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
