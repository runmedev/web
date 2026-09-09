import { expect, it } from 'vitest'

import { projectSourceCommentRange } from './sourceCommentProjection'

it('projects exact visible text and excludes link destinations and Markdown syntax', () => {
  const source = 'A **😀bold** [link](https://example.com)'
  expect(projectSourceCommentRange(source, 4, 9)).toEqual([
    { start: 2, end: 7 },
  ])
  const start = Array.from(source.slice(0, source.indexOf('https'))).length
  expect(projectSourceCommentRange(source, start, start + 19)).toEqual([])
})
