import { describe, expect, it } from 'vitest'

import {
  createPageProperties,
  notebookPages,
  pageDeletedKey,
  pageNameKey,
  pagePosition,
  pagePositionKey,
  resolvePage,
} from './notebookPages'

describe('notebook pages', () => {
  it('uses the first page for unassigned cells even with a legacy default', () => {
    const { id, changes } = createPageProperties([], 'Investigation')
    const main = notebookPages(changes)[0]!.id
    expect(changes).not.toHaveProperty('runme.dev/pages/defaultPageId')
    expect(main).not.toBe('default')
    const original = notebookPages(changes)
    expect(original.map((p) => p.name)).toEqual(['Main', 'Investigation'])
    const metadata = {
      ...changes,
      'runme.dev/pages/defaultPageId': main,
      [pageNameKey(main)]: 'Notes',
      [pagePositionKey(id)]: pagePosition(undefined, original[0]),
    }
    expect(notebookPages(metadata).map((p) => p.name)).toEqual([
      'Investigation',
      'Notes',
    ])
    expect(resolvePage(undefined, notebookPages(metadata))).toBe(id)
    expect(resolvePage(main, notebookPages(metadata))).toBe(main)
  })
  it('recovers dangling references and keeps a deleted page hidden after concurrent renaming', () => {
    const { id, changes } = createPageProperties([], 'Temporary')
    const live = notebookPages({
      ...changes,
      [pageDeletedKey(id)]: 'true',
      [pageNameKey(id)]: 'Renamed',
    })
    expect(resolvePage(id, live)).toBe(notebookPages(changes)[0]!.id)
    expect(resolvePage(undefined, [])).toBeUndefined()
  })
})
