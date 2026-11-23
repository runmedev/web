// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { it, expect } from 'vitest'
import { getGraderSettings } from '../../lib/suggestionGrader'
import { mockGraderSources } from '../../lib/suggestionGraderTestFixture'
import { SuggestionGraderSettings } from './SuggestionGraderSettings'
it('saves a vault name and mounted notebook after explicit opt-in', async () => {
  localStorage.clear()
  mockGraderSources()
  render(<SuggestionGraderSettings />)
  await screen.findByRole('option', { name: 'Editorial/rules.runme' })
  fireEvent.change(screen.getByLabelText('OpenAI key in Key Vault'), {
    target: { value: 'review' },
  })
  fireEvent.change(screen.getByLabelText('Instructions notebook'), {
    target: { value: 'local://file/rules' },
  })
  fireEvent.click(
    screen.getByLabelText('Enable automatic predictions when reviewing')
  )
  expect(getGraderSettings().enabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save grader settings' }))
  await waitFor(() =>
    expect(getGraderSettings()).toMatchObject({
      enabled: true,
      keyName: 'review',
      instructionsUri: 'local://file/rules',
    })
  )
  expect(localStorage.getItem('runme.suggestion-grader.v1')).not.toContain(
    'test-key'
  )
})
