import { describe, expect, it } from 'vitest'

import {
  buildReadInstructionsForCodexInputSchema,
  READ_INSTRUCTIONS_FOR_CODEX_TOOL_DESCRIPTION,
  readInstructionsForCodex,
} from './codexInstructions'

describe('readInstructionsForCodex', () => {
  it('tells Codex to read the instructions first', () => {
    expect(READ_INSTRUCTIONS_FOR_CODEX_TOOL_DESCRIPTION).toContain(
      'Call this tool first to understand the Runme page.'
    )
  })

  it('uses the supplied runtime origin in Runme URLs', () => {
    const instructions = readInstructionsForCodex(
      'https://runme.self-hosted.example:8443/path?ignored=true'
    )

    expect(instructions).toContain(
      'https://runme.self-hosted.example:8443/?session=<session-id>'
    )
    expect(instructions).not.toContain('https://runme.example')
  })

  it('includes the portable Runme collaboration rules', () => {
    const instructions = readInstructionsForCodex('https://runme.example')

    expect(instructions).toContain('WebMCP')
    expect(instructions).toContain('ExecuteCode')
    expect(instructions).toContain('await app.getSessionID()')
    expect(instructions).toContain('local://')
    expect(instructions).toContain("kind: 'markup'")
    expect(instructions).toContain('expectedRevision')
    expect(instructions).toContain('NOTEBOOK_UPDATE_FAILED')
    expect(instructions).toContain('verify')
  })

  it('does not include deployment-specific plugin instructions', () => {
    const instructions = readInstructionsForCodex('https://runme.example')

    expect(instructions).not.toMatch(
      /OpenAI|monorepo|RUNME_PLUGIN_ROOT|manage_runner|go\/runme|9988/
    )
  })

  it('defines a strict no-argument input schema', () => {
    expect(buildReadInstructionsForCodexInputSchema()).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    })
  })
})
