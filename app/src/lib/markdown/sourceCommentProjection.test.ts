import { expect, it } from 'vitest'

import {
  buildRenderedMarkdownProjection,
  sourceRangeForRenderedSelection,
} from './renderedMarkdownProjection'
import {
  projectSourceCommentRange,
  renderedSelectionQuote,
  renderedSelectionRange,
} from './sourceCommentProjection'

it('projects exact visible text and excludes link destinations and Markdown syntax', () => {
  const source = 'A **😀bold** [link](https://example.com)'
  expect(projectSourceCommentRange(source, 4, 9)).toEqual([
    { start: 2, end: 7 },
  ])
  const start = Array.from(source.slice(0, source.indexOf('https'))).length
  expect(projectSourceCommentRange(source, start, start + 19)).toEqual([])
})

it('round-trips one selection across a long URL, formatting and an emoji', () => {
  const source = '😀 Read [guide](https://example.org/a/long/path) **today**.'
  const projection = buildRenderedMarkdownProjection(source)
  const range = sourceRangeForRenderedSelection(projection, source, 7, 18)!
  expect(source.slice(range.start, range.end)).toBe(
    'guide](https://example.org/a/long/path) **today'
  )
  const start = Array.from(source.slice(0, range.start)).length
  const end = Array.from(source.slice(0, range.end)).length
  expect(renderedSelectionRange(source, start, end)).toEqual({
    start: 7,
    end: 18,
  })
  expect(renderedSelectionQuote(source, start, end)).toBe('guide today')
})
