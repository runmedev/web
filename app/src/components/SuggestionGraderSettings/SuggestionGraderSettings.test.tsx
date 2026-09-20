// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import {
  getGraderSettings,
  saveGraderSettings,
} from '../../lib/suggestionGrader'
import { SuggestionGraderSettings } from './SuggestionGraderSettings'
beforeEach(() => localStorage.clear())
it('requires an explicit save and enable; masks and clears the key draft', () => {
  render(<SuggestionGraderSettings />)
  fireEvent.change(screen.getByLabelText('Model ID'), {
    target: { value: 'ft:test' },
  })
  const key = screen.getByLabelText(
    'Grader API key (optional)'
  ) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'test-secret' } })
  expect(key.type).toBe('password')
  expect(getGraderSettings().enabled).toBe(false)
  fireEvent.click(
    screen.getByLabelText('Enable automatic predictions when reviewing')
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save grader settings' }))
  expect(getGraderSettings()).toMatchObject({
    enabled: true,
    model: 'ft:test',
    hasDedicatedKey: true,
  })
  expect(key.value).toBe('')
  expect(screen.getByRole('status').textContent).toBe(
    'AI grader settings saved.'
  )
})
it('does not reveal existing credentials and can clear a dedicated key', () => {
  saveGraderSettings({
    enabled: false,
    model: 'ft:test',
    organization: '',
    project: '',
    apiKey: 'test-secret',
  })
  render(<SuggestionGraderSettings />)
  expect(
    (screen.getByLabelText('Grader API key (optional)') as HTMLInputElement)
      .value
  ).toBe('')
  fireEvent.click(screen.getByLabelText('Clear dedicated key on save'))
  fireEvent.click(screen.getByRole('button', { name: 'Save grader settings' }))
  expect(getGraderSettings().hasDedicatedKey).toBe(false)
})
