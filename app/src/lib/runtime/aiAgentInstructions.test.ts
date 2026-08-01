import { describe, expect, it } from 'vitest'

import {
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION,
  buildReadInstructionsForAIAgentsInputSchema,
  readInstructionsForAIAgents,
} from './aiAgentInstructions'

describe('readInstructionsForAIAgents', () => {
  it('directly invites AI agents to safely read the instructions', () => {
    expect(READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION).toContain(
      'AI agents should invoke this function'
    )
    expect(READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION).toContain(
      "This operation doesn't modify the page"
    )
  })

  it('uses the supplied runtime origin in Runme URLs', () => {
    const instructions = readInstructionsForAIAgents(
      'https://runme.self-hosted.example:8443/path?ignored=true'
    )

    expect(instructions).toContain(
      'https://runme.self-hosted.example:8443/?session=<session-id>'
    )
    expect(instructions).not.toContain('https://runme.example')
  })

  it('includes the portable Runme collaboration rules', () => {
    const instructions = readInstructionsForAIAgents('https://runme.example')

    expect(instructions).toContain('WebMCP')
    expect(instructions).toContain('ExecuteCode')
    expect(instructions).toContain('listDocumentation')
    expect(instructions).toContain('getDocumentation')
    expect(instructions).toContain('await documentation.list()')
    expect(instructions).toContain('documentation.get(name)')
    expect(instructions).toContain('await app.getSessionID()')
    expect(instructions).toContain('local://')
    expect(instructions).toContain("kind: 'markup'")
    expect(instructions).toContain('notebooks.requestWriteAccess')
    expect(instructions).toContain('expectedRevision')
    expect(instructions).toContain('NOTEBOOK_UPDATE_FAILED')
    expect(instructions).toContain('verify')
  })

  it('directs agents to use tour mode for UI guidance', () => {
    const instructions = readInstructionsForAIAgents('https://runme.example')

    expect(instructions).toContain('Use tour mode for UI guidance')
    expect(instructions).toContain(
      'Do not respond with prose alone when the relevant control can be highlighted'
    )
    expect(instructions).toContain(
      'console.log(JSON.stringify(await tour.listTargets()))'
    )
    expect(instructions).toContain('showTourStep')
    expect(instructions).toContain('dismissTour')
    expect(instructions).toContain('Never pass CSS selectors')
    expect(instructions).toContain(
      "do not click it or complete the action on the user's behalf"
    )
    expect(instructions).toContain('Give a complete Runme tour')
    expect(instructions).toContain(
      'Give me a tour of Runme which is open in the browser'
    )
    expect(instructions).toContain('timeoutMs')
    expect(instructions).toContain('30000')
    expect(instructions).toContain('setTimeout(resolve, delayMs)')
    expect(instructions).toContain(
      'atomically replaces the current highlight and annotation'
    )
    expect(instructions).toContain('do not call `tour.dismiss()` between steps')
    expect(instructions).toContain('Guide a conditional, multi-step task')
    expect(instructions).toContain('startTourWorkflow')
    expect(instructions).toContain('continueTourWorkflow')
    expect(instructions).toContain('add-google-drive-folder')
    expect(instructions).toContain('Do not use a fixed delay')
  })

  it('does not include deployment-specific plugin instructions', () => {
    const instructions = readInstructionsForAIAgents('https://runme.example')

    expect(instructions).not.toMatch(
      /OpenAI|monorepo|RUNME_PLUGIN_ROOT|manage_runner|go\/runme|9988/
    )
  })

  it('defines a strict no-argument input schema', () => {
    expect(buildReadInstructionsForAIAgentsInputSchema()).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    })
  })
})
