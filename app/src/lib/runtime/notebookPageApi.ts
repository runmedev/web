import {
  CELL_PAGE,
  type NotebookPage,
  createPageProperties,
  notebookPages,
  pageDeletedKey,
  pageNameKey,
  pagePosition,
  pagePositionKey,
} from '../notebookPages'
import { showWorkspaceDocument } from '../workspaceDocuments/workspaceDocumentController'
import { notebookPageUri } from '../workspaceDocuments/workspaceDocumentTypes'
import {
  type NotebookDataLike,
  type NotebookTarget,
  makeHandle,
  resolveNotebookTargetUri,
} from './runmeConsole'

type PageTarget = { target: NotebookTarget; expectedRevision?: string }
type PageSelection = PageTarget & { pageId: string }
export const pageHelp = {
  listPages:
    'notebooks.listPages({target}) returns {handle,pages:[{id,name,cellRefIds}]}, in Outline order. The first page is the default. An implicit Main has id:null.',
  createPage:
    'notebooks.createPage({target,name,expectedRevision?}) appends a page and returns {id,name}. Creation in an unpaged notebook preserves its existing cells on Main.',
  renamePage:
    'notebooks.renamePage({target,pageId,name,expectedRevision?}) returns {id,name}. Pass pageId:null to name an implicit Main.',
  movePage:
    'notebooks.movePage({target,pageId,beforePageId,expectedRevision?}) reorders a page before a sibling. Pass beforePageId:null to move to the end.',
  removePage:
    'notebooks.removePage({target,pageId,expectedRevision?}) removes the page and keeps its cells on the first remaining page, or implicit Main.',
  moveCellToPage:
    'notebooks.moveCellToPage({target,refId,pageId,expectedRevision?}) assigns an existing cell. Pass pageId:null for a cell that follows the first page after reordering.',
  showPage:
    'notebooks.showPage({target,pageId}) opens or focuses a page tab. Pass pageId:null for the implicit Main.',
}

function requirePage(pages: NotebookPage[], id: string | null) {
  const page = pages.find((p) => p.id === id)
  if (!page)
    throw new Error(
      'Unknown page ID. Read notebooks.listPages({target}) for current IDs.'
    )
  return page
}

/** Operate synchronously on the targeted model before awaiting persistence. */
export function createNotebookPageApi(
  resolve: (uri: string) => NotebookDataLike | null | undefined
) {
  function model(args: PageTarget, write = false) {
    const uri = resolveNotebookTargetUri(args?.target)
    if (!uri) throw new Error('An explicit notebook target is required.')
    const data = resolve(uri)
    if (!data || data.getUri() !== uri || data.getSnapshot?.().loaded === false)
      throw new Error('Open the target notebook first.')
    if (
      write &&
      (data.isReadOnly?.() ||
        data.isReleasePending?.() ||
        data.isReviewPending?.())
    )
      throw new Error('The target notebook is not writable.')
    const revision =
      args.expectedRevision ??
      ('handle' in args.target ? args.target.handle.revision : undefined)
    if (revision !== undefined && makeHandle(data).revision !== revision)
      throw new Error('Revision mismatch. Read the notebook again.')
    return data
  }
  async function commit(
    data: NotebookDataLike,
    changes: Record<string, string>
  ) {
    if (!data.setMetadataProperties)
      throw new Error('This notebook does not support page edits.')
    data.setMetadataProperties(changes)
    await data.flushPendingPersist?.()
  }
  return {
    listPages: async (args: PageTarget) => {
      const data = model(args)
      const doc = data.getNotebook()
      const pages = notebookPages(doc.metadata)
      const records = (pages.length ? pages : [{ id: null, name: 'Main' }]).map(
        ({ id, name }) => ({ id, name, cellRefIds: [] as string[] })
      )
      const byId = new Map(records.map((page) => [page.id, page]))
      for (const cell of doc.cells)
        (byId.get(cell.metadata[CELL_PAGE]) ?? records[0]).cellRefIds.push(
          cell.refId
        )
      return { handle: makeHandle(data), pages: records }
    },
    createPage: async (args: PageTarget & { name: string }) => {
      const data = model(args, true)
      const { id, changes } = createPageProperties(
        notebookPages(data.getNotebook().metadata),
        args.name
      )
      await commit(data, changes)
      return { id, name: args.name.trim() }
    },
    renamePage: async (
      args: PageTarget & { pageId: string | null; name: string }
    ) => {
      const data = model(args, true)
      const pages = notebookPages(data.getNotebook().metadata)
      const name = args.name?.trim()
      if (!name) throw new Error('A page name is required.')
      const change =
        !pages.length && args.pageId === null
          ? createPageProperties(pages, name, false)
          : {
              id: requirePage(pages, args.pageId).id,
              changes: { [pageNameKey(args.pageId!)]: name },
            }
      await commit(data, change.changes)
      return { id: change.id, name }
    },
    movePage: async (args: PageSelection & { beforePageId: string | null }) => {
      const data = model(args, true)
      const pages = notebookPages(data.getNotebook().metadata)
      const page = requirePage(pages, args.pageId)
      const before =
        args.beforePageId === null
          ? undefined
          : requirePage(pages, args.beforePageId)
      const index = pages.indexOf(page)
      if (before === page || before === pages[index + 1]) return { id: page.id }
      const others = pages.filter((p) => p !== page)
      const at = before ? others.indexOf(before) : others.length
      await commit(data, {
        [pagePositionKey(page.id)]: pagePosition(others[at - 1], before),
      })
      return { id: page.id }
    },
    removePage: async (args: PageSelection) => {
      const data = model(args, true)
      const page = requirePage(
        notebookPages(data.getNotebook().metadata),
        args.pageId
      )
      await commit(data, { [pageDeletedKey(page.id)]: 'true' })
      return { id: page.id }
    },
    moveCellToPage: async (
      args: PageTarget & { refId: string; pageId: string | null }
    ) => {
      const data = model(args, true)
      const doc = data.getNotebook()
      if (args.pageId !== null)
        requirePage(notebookPages(doc.metadata), args.pageId)
      const cell = doc.cells.find((c) => c.refId === args.refId)
      if (!cell) throw new Error('Unknown cell refId.')
      const metadata = { ...cell.metadata }
      if (args.pageId === null) delete metadata[CELL_PAGE]
      else metadata[CELL_PAGE] = args.pageId
      data.updateCell({ ...cell, metadata })
      await data.flushPendingPersist?.()
      return { refId: cell.refId, pageId: args.pageId }
    },
    showPage: async (args: PageTarget & { pageId: string | null }) => {
      const data = model(args)
      const pages = notebookPages(data.getNotebook().metadata)
      const page =
        args.pageId === null && !pages.length
          ? undefined
          : requirePage(pages, args.pageId)
      const source = data.getUri()
      const uri = page ? notebookPageUri(source, page.id) : source
      showWorkspaceDocument(uri, {
        title: page?.name ?? data.getName(),
        afterUri: page ? source : undefined,
      })
      return { uri }
    },
  }
}
