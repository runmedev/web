import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PAGE,
  createPageProperties,
  notebookPages,
  pageDeletedKey,
  pageNameKey,
  pagePosition,
  pagePositionKey,
  resolvePage,
} from './notebookPages'

describe('notebook pages', () => {
  it('keeps unassigned cells on the same page through rename and reorder', () => {
    const { id, changes } = createPageProperties([], 'Investigation')
    const main = changes[DEFAULT_PAGE]!
    expect(main).not.toBe('default')
    const original = notebookPages(changes)
    expect(original.map((p) => p.name)).toEqual(['Main', 'Investigation'])
    const metadata = {
      ...changes,
      [pageNameKey(main)]: 'Notes',
      [pagePositionKey(id)]: pagePosition(undefined, original[0]),
    }
    expect(notebookPages(metadata).map((p) => p.name)).toEqual([
      'Investigation',
      'Notes',
    ])
    expect(resolvePage(undefined, notebookPages(metadata), main)).toBe(main)
  })
  it('recovers dangling references and keeps a deleted page hidden after concurrent renaming', () => {
    const { id, changes } = createPageProperties([], 'Temporary')
    const live = notebookPages({
      ...changes,
      [pageDeletedKey(id)]: 'true',
      [pageNameKey(id)]: 'Renamed',
    })
    expect(resolvePage(id, live, id)).toBe(changes[DEFAULT_PAGE])
    expect(resolvePage(undefined, [], undefined)).toBeUndefined()
  })
})
