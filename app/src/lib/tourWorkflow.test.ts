// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { tourGuideStore } from './tourGuide'
import {
  cancelTourWorkflow,
  getTourWorkflowStatus,
  incrementTourState,
  listTourWorkflows,
  publishTourState,
  resetTourWorkflowForTests,
  showNextTourWorkflowStep,
  startTourWorkflow,
  waitForTourWorkflowChange,
} from './tourWorkflow'

describe('tourWorkflow', () => {
  afterEach(() => {
    resetTourWorkflowForTests()
  })

  it('resolves the first incomplete conditional step', () => {
    publishTourState('google-drive.authorized', false)
    publishTourState('side-panel.active', null)

    const auth = startTourWorkflow('add-google-drive-folder')
    expect(auth.step?.id).toBe('authorize-google-drive')

    publishTourState('google-drive.authorized', true)
    const explorer = getTourWorkflowStatus(auth.sessionId)
    expect(explorer.step?.id).toBe('open-file-explorer')

    publishTourState('side-panel.active', 'explorer')
    const addFolder = getTourWorkflowStatus(auth.sessionId)
    expect(addFolder.step?.id).toBe('add-google-drive-folder')

    incrementTourState('google-drive.folder-added-count')
    expect(getTourWorkflowStatus(auth.sessionId).status).toBe('complete')
  })

  it('skips equality conditions that are already satisfied', () => {
    publishTourState('google-drive.authorized', true)
    publishTourState('side-panel.active', 'explorer')

    const status = startTourWorkflow('add-google-drive-folder')

    expect(status.step?.id).toBe('add-google-drive-folder')
  })

  it('shows the next step and replaces it as state advances', () => {
    publishTourState('google-drive.authorized', false)
    publishTourState('side-panel.active', null)
    const started = startTourWorkflow('add-google-drive-folder')

    showNextTourWorkflowStep(started.sessionId, {
      message: 'Authorize Drive now.',
    })
    expect(tourGuideStore.getSnapshot()).toMatchObject({
      target: 'left-nav.google-drive',
      message: 'Authorize Drive now.',
    })

    publishTourState('google-drive.authorized', true)
    showNextTourWorkflowStep(started.sessionId)
    expect(tourGuideStore.getSnapshot()?.target).toBe('left-nav.explorer')
  })

  it('waits for a later state revision without missing the change', async () => {
    publishTourState('google-drive.authorized', false)
    const started = startTourWorkflow('add-google-drive-folder')
    const waiting = waitForTourWorkflowChange({
      sessionId: started.sessionId,
      afterRevision: started.revision,
      timeoutMs: 1_000,
    })

    publishTourState('google-drive.authorized', true)

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      step: { id: 'open-file-explorer' },
    })
  })

  it('returns immediately when state advanced between calls', async () => {
    publishTourState('google-drive.authorized', false)
    const started = startTourWorkflow('add-google-drive-folder')
    publishTourState('google-drive.authorized', true)

    await expect(
      waitForTourWorkflowChange({
        sessionId: started.sessionId,
        afterRevision: started.revision,
      })
    ).resolves.toMatchObject({ timedOut: false })
  })

  it('times out without cancelling the active session', async () => {
    const started = startTourWorkflow('add-google-drive-folder')

    await expect(
      waitForTourWorkflowChange({
        sessionId: started.sessionId,
        afterRevision: started.revision,
        timeoutMs: 1,
      })
    ).resolves.toMatchObject({ timedOut: true, sessionId: started.sessionId })
    expect(getTourWorkflowStatus(started.sessionId).status).toBe('waiting')
  })

  it('invalidates stale sessions and supports explicit cancellation', () => {
    const first = startTourWorkflow('add-google-drive-folder')
    const second = startTourWorkflow('add-google-drive-folder')

    expect(() => getTourWorkflowStatus(first.sessionId)).toThrow(
      'no longer active'
    )
    expect(cancelTourWorkflow(second.sessionId)).toBe(true)
    expect(() => getTourWorkflowStatus(second.sessionId)).toThrow(
      'No tour workflow is active'
    )
  })

  it('returns defensive workflow definitions', () => {
    const workflows = listTourWorkflows() as unknown as Array<{
      label: string
      steps: Array<{ title: string }>
    }>
    workflows[0]!.label = 'Changed'
    workflows[0]!.steps[0]!.title = 'Changed'

    expect(listTourWorkflows()[0]?.label).toBe('Add a Google Drive folder')
    expect(listTourWorkflows()[0]?.steps[0]?.title).toBe('Connect Google Drive')
  })
})
