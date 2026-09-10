import { create } from '@bufbuild/protobuf'
import { Theme } from '@radix-ui/themes'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parser_pb } from '../runme/client'
import { AUTO_IPYNB_KEY } from '../lib/derivedNotebook'
import { NotebookPropertiesDialog } from './NotebookPropertiesDialog'

const mocks = vi.hoisted(() => ({
  snapshot: {} as any,
  setMetadataProperty: vi.fn(),
  flushPendingPersist: vi.fn(async () => {}),
  getIpynbExportState: vi.fn(async () => ({})),
  retryUnconfirmedIpynbCreation: vi.fn(async () => {}),
  syncIpynbFile: vi.fn(async () => {}),
}))
vi.mock('../contexts/NotebookContext', () => ({
  useNotebookContext: () => ({
    useNotebookSnapshot: () => mocks.snapshot,
    getNotebookData: () => mocks,
  }),
}))
vi.mock('../contexts/NotebookStoreContext', () => ({
  useNotebookStore: () => ({
    store: {
      getIpynbExportState: mocks.getIpynbExportState,
      retryUnconfirmedIpynbCreation: mocks.retryUnconfirmedIpynbCreation,
      syncIpynbFile: mocks.syncIpynbFile,
      subscribeSync: () => () => {},
    },
  }),
}))

describe('Notebook properties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getIpynbExportState.mockResolvedValue({})
    mocks.syncIpynbFile.mockResolvedValue()
    mocks.snapshot = {
      loaded: true,
      readOnly: false,
      name: 'test.runme',
      notebook: create(parser_pb.NotebookSchema),
    }
  })
  it('sets and unsets automatic export through a persisted model mutation', async () => {
    const view = render(
      <Theme>
        <NotebookPropertiesDialog uri="local://file/test" onClose={() => {}} />
      </Theme>
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() =>
      expect(mocks.flushPendingPersist).toHaveBeenCalledTimes(1)
    )
    expect(mocks.setMetadataProperty).toHaveBeenLastCalledWith(
      AUTO_IPYNB_KEY,
      'true'
    )
    mocks.snapshot.notebook.metadata[AUTO_IPYNB_KEY] = 'true'
    view.rerender(
      <Theme>
        <NotebookPropertiesDialog uri="local://file/test" onClose={() => {}} />
      </Theme>
    )
    await waitFor(() =>
      expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() =>
      expect(mocks.setMetadataProperty).toHaveBeenLastCalledWith(
        AUTO_IPYNB_KEY,
        'false'
      )
    )
  })
  it('prevents changing a read-only notebook', async () => {
    mocks.snapshot.readOnly = true
    render(
      <Theme>
        <NotebookPropertiesDialog uri="local://file/test" onClose={() => {}} />
      </Theme>
    )
    await waitFor(() => expect(mocks.getIpynbExportState).toHaveBeenCalled())
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(
      true
    )
  })
  it('retries a failed export without changing the saved notebook', async () => {
    mocks.snapshot.notebook.metadata[AUTO_IPYNB_KEY] = 'true'
    mocks.getIpynbExportState.mockResolvedValue({
      error: 'Unsupported notebook log format_version 2',
    })
    mocks.syncIpynbFile.mockRejectedValueOnce(new Error('Drive is offline'))
    render(
      <Theme>
        <NotebookPropertiesDialog uri="local://file/test" onClose={() => {}} />
      </Theme>
    )
    const retry = await screen.findByRole('button', {
      name: 'Retry Colab export',
    })
    expect(
      screen.queryByText(/Waiting for the next background export/)
    ).toBeNull()
    fireEvent.click(retry)
    await screen.findByText('Export retry failed: Error: Drive is offline')
    expect(mocks.syncIpynbFile).toHaveBeenCalledWith('local://file/test')
    expect(mocks.setMetadataProperty).not.toHaveBeenCalled()
    expect(mocks.flushPendingPersist).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.syncIpynbFile).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Export retry failed/)).toBeNull()
  })
  it('requires confirmation before retrying an unconfirmed creation', async () => {
    mocks.snapshot.notebook.metadata[AUTO_IPYNB_KEY] = 'true'
    mocks.getIpynbExportState.mockResolvedValue({ needsCreateRecovery: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <Theme>
        <NotebookPropertiesDialog uri="local://file/test" onClose={() => {}} />
      </Theme>
    )
    const retry = await screen.findByRole('button', {
      name: 'Retry unconfirmed creation',
    })
    expect(
      screen.queryByRole('button', { name: 'Retry Colab export' })
    ).toBeNull()
    fireEvent.click(retry)
    expect(mocks.retryUnconfirmedIpynbCreation).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(retry)
    await waitFor(() =>
      expect(mocks.retryUnconfirmedIpynbCreation).toHaveBeenCalledWith(
        'local://file/test'
      )
    )
    confirm.mockRestore()
  })
})
