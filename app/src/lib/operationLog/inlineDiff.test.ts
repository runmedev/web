import { describe, expect, it } from 'vitest'

import { type InlineDiffSegment, diffInlineText } from './inlineDiff'

/** Check both source reconstructions used by the diff's comment offsets. */
function verifyEndpoints(before: string, after: string): InlineDiffSegment[] {
  const segments = diffInlineText(before, after)
  expect(
    segments
      .filter((run) => run.kind !== 'inserted')
      .map((run) => run.value)
      .join('')
  ).toBe(before)
  expect(
    segments
      .filter((run) => run.kind !== 'deleted')
      .map((run) => run.value)
      .join('')
  ).toBe(after)
  segments.forEach((run, index) => {
    expect(run.value).not.toBe('')
    expect(run.kind).not.toBe(segments[index - 1]?.kind)
  })
  return segments
}

describe('diffInlineText', () => {
  it.each([199, 201, 10_000])(
    'only marks the added word in a %i-word cell',
    (count) => {
      const before = 'word '.repeat(count)
      expect(verifyEndpoints(before, `${before}extra`)).toEqual([
        { kind: 'equal', value: before },
        { kind: 'inserted', value: 'extra' },
      ])
    }
  )

  it('preserves unchanged paragraphs around multiple edits in a long cell', () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `Paragraph ${i}: keep this explanation.\n`
    )
    const before = lines.join('')
    const after = before
      .replace('Paragraph 10:', 'Section 10:')
      .replace('Paragraph 190:', 'Section 190:')
    const segments = verifyEndpoints(before, after)
    expect(
      segments.filter((run) => run.kind === 'deleted').map((run) => run.value)
    ).toEqual(['Paragraph', 'Paragraph'])
    expect(
      segments.filter((run) => run.kind === 'inserted').map((run) => run.value)
    ).toEqual(['Section', 'Section'])
  })

  it('retains CUJ headings and shared wording while revising long sections', () => {
    const before = [
      '## Critical user journey\n\n',
      '### User comments on latest version\n\n',
      '1. User open a .runme notebook\n',
      '2. User reads latest version\n',
      '3. User leaves a bunch of comments on that version\n\n',
      '### Codex addresses comments\n\n',
      '1. User: @codex please address the comments\n',
      '2. Codex makes a bunch of changes\n',
      '3. Codex replies to the comment thread to explain its changes\n\n',
      '### User reviews changes\n\n',
      'User reviews each suggestion and leaves comments.\n'.repeat(100),
    ].join('')
    const after = [
      '## Critical user journey\n\n',
      '### Human requests changes\n\n',
      '1. Open and read a .runme notebook.\n',
      '2. Leave comments on cells or selected text. Name the revision being reviewed.\n',
      '3. Ask Codex to address the comments.\n\n',
      '### Codex addresses comments\n\n',
      '1. Read the comments and edit the same document.\n',
      '2. Reply in the existing threads to explain the changes.\n',
      '3. Identify the revised version for the human to compare.\n\n',
      '### Human reviews and iterates\n\n',
      'Human reviews each suggestion and leaves comments.\n'.repeat(100),
    ].join('')
    const equalText = verifyEndpoints(before, after)
      .filter((run) => run.kind === 'equal')
      .map((run) => run.value)
      .join('')
    expect(equalText).toContain('## Critical user journey\n')
    expect(equalText).toContain('### Codex addresses comments\n')
    expect(equalText).toContain('a .runme notebook')
  })

  it('preserves interior line anchors when the matrix budget is exceeded', () => {
    const before = `${'old\n'.repeat(2000)}## Kept section\n${'old ending\n'.repeat(2000)}`
    const after = `${'new\n'.repeat(2000)}## Kept section\n${'new ending\n'.repeat(2000)}`
    expect(
      verifyEndpoints(before, after).some(
        (run) => run.kind === 'equal' && run.value.includes('## Kept section\n')
      )
    ).toBe(true)
  })

  it('retains unique interior word anchors in oversized single-line rewrites', () => {
    const before = `${'old '.repeat(2000)}unchanged ${'old '.repeat(2000)}`
    const after = `${'new '.repeat(2000)}unchanged ${'new '.repeat(2000)}`
    expect(
      verifyEndpoints(before, after).some(
        (run) => run.kind === 'equal' && run.value.includes('unchanged')
      )
    ).toBe(true)
  })

  it('orders multiple anchors without crossing matches in large moved blocks', () => {
    const before = Array.from(
      { length: 1500 },
      (_, i) => `Paragraph ${i}\n`
    ).join('')
    const after = Array.from(
      { length: 1500 },
      (_, i) => `Paragraph ${(i + 750) % 1500}\n`
    ).join('')
    const unchanged = verifyEndpoints(before, after)
      .filter((run) => run.kind === 'equal')
      .map((run) => run.value)
      .join('')
    expect(unchanged.split('\n').length).toBeGreaterThan(700)
  })

  it.each([
    ['', ''],
    ['', 'inserted\n'],
    ['deleted\n', ''],
    ['same\n', 'same\n'],
    ['one\ntwo\n', 'two\none\n'],
    ['日本語 café 👩🏽‍💻\r\n\tkeep\n', '日本語 cafés 👩🏽‍💻\r\n  keep'],
    ['a\nb', 'a\nb\n'],
    ['\n\n', '\r\n\r\n'],
  ])('preserves exact endpoints %j → %j', (before, after) => {
    verifyEndpoints(before, after)
  })

  it('reconstructs repeated-token and moved-line combinations deterministically', () => {
    let seed = 42
    const randomText = (): string => {
      const choices = ['a', 'b', ' ', '\n', '\r\n', '\t', '🙂', 'é', '## ']
      return Array.from({ length: 50 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return choices[seed % choices.length]
      }).join('')
    }
    for (let i = 0; i < 200; i += 1) {
      const before = randomText()
      const after = randomText()
      expect(verifyEndpoints(before, after)).toEqual(
        diffInlineText(before, after)
      )
    }
  })
})
