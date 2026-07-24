import { describe, expect, it } from 'vitest'

import { getCellTitle } from './cellContent'

describe('getCellTitle', () => {
  it('uses the first non-empty line', () => {
    expect(getCellTitle('\n  First useful line  \nSecond line')).toBe(
      'First useful line'
    )
  })

  it.each([
    ['# Markdown heading', 'Markdown heading'],
    ['### Nested heading', 'Nested heading'],
    ['// JavaScript comment', 'JavaScript comment'],
    ['// # Commented heading', 'Commented heading'],
    ['#// Layered markers', 'Layered markers'],
  ])('strips heading and comment markers from %j', (value, expected) => {
    expect(getCellTitle(value)).toBe(expected)
  })

  it('falls back for empty or marker-only cells', () => {
    expect(getCellTitle('')).toBe('Untitled cell')
    expect(getCellTitle('\n  ###  \n')).toBe('Untitled cell')
  })
})
