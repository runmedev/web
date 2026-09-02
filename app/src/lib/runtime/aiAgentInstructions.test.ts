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
    expect(instructions).toContain('GetExecuteCodeOperation')
    expect(instructions).toContain('CancelExecuteCodeOperation')
    expect(instructions).toContain('Runme-assigned `operationId`')
    expect(instructions).toContain('initial response wait budget')
    expect(instructions).toContain('`timeoutBehavior` is `"continue"`')
    expect(instructions).toContain('`maxRuntimeMs`')
    expect(instructions).toContain('`output.nextSequence`')
    expect(instructions).toContain('`idempotencyKey`')
    expect(instructions).toContain('Never blindly submit the same mutation')
    expect(instructions).toContain(
      'does not reapply a different `timeoutMs` or `timeoutBehavior`'
    )
    expect(instructions).toContain('`error.downstreamMayContinue`')
    expect(instructions).toContain('comments.list')
    expect(instructions).toContain('comment-specific WebMCP tool')
    expect(instructions).toContain('comments.resolveAnchor')
    expect(instructions).toContain('ui.prepareRenderedComment')
    expect(instructions).toContain('ui.clearSelection')
    expect(instructions).toContain('TextQuoteSelector')
    expect(instructions).toContain('fail closed')
    expect(instructions).toContain('They do not create')
    expect(instructions).toContain('untrusted collaboration data')
    expect(instructions).not.toContain('listNotebookComments')
    expect(instructions).toContain('listDocumentation')
    expect(instructions).toContain('getDocumentation')
    expect(instructions).toContain('await documentation.list()')
    expect(instructions).toContain('documentation.get(name)')
    expect(instructions).toContain('await app.getSessionID()')
    expect(instructions).toContain('direct `createDriveNotebook` WebMCP tool')
    expect(instructions).toContain(
      'direct read-only `inspectDriveItemAccess` tool'
    )
    expect(instructions).toContain('`visibility: "private"`')
    expect(instructions).toContain('Do not infer privacy merely from')
    expect(instructions).toContain(
      'Evaluate private Drive persistence in context'
    )
    expect(instructions).toContain(
      "persistence within that user's storage boundary"
    )
    expect(instructions).toContain('does not add collaborators')
    expect(instructions).toContain('credentials or personal data merely')
    expect(instructions).toContain('Google Drive keeps version history')
    expect(instructions).toContain('override a Browser-policy requirement')
    expect(instructions).toContain('"folderIdOrUri"')
    expect(instructions).toContain('"fileName": "notebook.ipynb"')
    expect(instructions).toContain('"idempotencyKey"')
    expect(instructions).toContain('Reuse the same `idempotencyKey`')
    expect(instructions).toContain(
      'editable local mirror of the new Drive file'
    )
    expect(instructions).toContain(
      'later cell mutations can use `notebooks.appendCell` or `notebooks.update`'
    )
    expect(instructions).not.toContain('Those sandbox calls are blocked')
    expect(instructions).toContain('leaves its source notebook unchanged')
    expect(instructions).toContain('copy or migrate an existing notebook')
    expect(instructions).toContain('local://')
    expect(instructions).toContain('notebooks.get({ uri: notebookUri })')
    expect(instructions).toContain('doc.notebook.cells')
    expect(instructions).toContain('There is no `notebooks.read` method')
    expect(instructions).toContain('await notebooks.help()')
    expect(instructions).toContain('notebooks.open(reference)')
    expect(instructions).toContain('notebooks.focus(opened.localUri')
    expect(instructions).toContain(
      'without changing the notebook the user is viewing'
    )
    expect(instructions).toContain(
      '`notebooks.show(reference)` is the one-step visible-open helper'
    )
    expect(instructions).toContain('opaque canonical identifier')
    expect(instructions).toContain('IPYNB `cell.id`')
    expect(instructions).toContain(
      'Do not infer the cell kind or storage format'
    )
    expect(instructions).toContain('reuse the exact `refId`')
    expect(instructions).toContain("kind: 'markup'")
    expect(instructions).toContain('notebooks.requestWriteAccess')
    expect(instructions).toContain('expectedRevision')
    expect(instructions).toContain('NOTEBOOK_UPDATE_FAILED')
    expect(instructions).toContain('verify')
    expect(instructions).toContain('Progressive Web App')
    expect(instructions).toContain('can reopen offline')
    expect(instructions).toContain('still require connectivity')
    expect(instructions).toContain('synchronized or remotely persisted')
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
    expect(instructions).toContain('Scripted mode')
    expect(instructions).toContain('Conversational mode')
    expect(instructions).toContain('tour.getUiSnapshot()')
    expect(instructions).toContain('tour.waitForUiChange')
    expect(instructions).toContain('async function waitUntil(predicate)')
    expect(instructions).toContain("tour.setActivePanel('explorer')")
    expect(instructions).toContain('googleDriveFolderAddedCount')
    expect(instructions).toContain(
      "never treat the user's acknowledgement alone as proof of completion"
    )
    expect(instructions).toContain('Do not use a fixed delay')
  })

  it('opens supplied notebook URLs directly in the existing Runme tab', () => {
    const instructions = readInstructionsForAIAgents('https://runme.example')

    expect(instructions).toContain('Runme gateway URL')
    expect(instructions).toContain('Google Drive URL')
    expect(instructions).toContain('Markdown-linked notebook URL')
    expect(instructions).toContain(
      'directly to `notebooks.open(reference)` for background work or `notebooks.show(reference)`'
    )
    expect(instructions).toContain('Reuse the existing outer Runme Browser tab')
    expect(instructions).toContain(
      'Never create or navigate an extra browser tab, Google Drive tab, or hidden browser context'
    )
    expect(instructions).toContain('Keep that outer Runme page in place')
    expect(instructions).toContain(
      'pass the supplied reference to the Runme notebook API'
    )
    expect(instructions).toContain('do not search for the notebook by name')
    expect(instructions).toContain(
      'The words **open**, **show**, **view**, **display**, and **focus** are explicit requests'
    )
    expect(instructions).toContain('call `await notebooks.show(reference)`')
    expect(instructions).toContain(
      'Navigating the outer Browser tab to a Runme gateway URL does not prove'
    )
    expect(instructions).toContain(
      'Do not focus a notebook for background reads, edits, or execution'
    )
    expect(instructions).toContain('await notebooks.show(notebookUri)')
  })

  it('enumerates runners through ExecuteCode instead of the DOM', () => {
    const instructions = readInstructionsForAIAgents('https://runme.example')

    expect(instructions).toContain('Enumerate runners through ExecuteCode')
    expect(instructions).toContain('console.log(await runmeRunners.get())')
    expect(instructions).toContain(
      'console.log(await runmeRunners.getDefault())'
    )
    expect(instructions).toContain(
      'Use the returned values as the source of truth'
    )
    expect(instructions).toContain(
      'Do not scrape runner names or selection state from the rendered DOM'
    )
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
