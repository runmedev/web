// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OpenAISettings } from './OpenAISettings'
import { getOpenAIAuthStatus } from '../../lib/openaiTraining'

beforeEach(() => localStorage.clear())
afterEach(cleanup)
it('saves and clears a masked key independently of Google settings', () => {
  render(<OpenAISettings />)
  const input = screen.getByLabelText('OpenAI API key') as HTMLInputElement
  expect(input.type).toBe('password')
  fireEvent.change(input, { target: { value: 'test-secret' } })
  fireEvent.click(screen.getByText('Save OpenAI key'))
  expect(getOpenAIAuthStatus().configured).toBe(true)
  expect(input.value).toBe('')
  expect(screen.getByRole('status').textContent).toBe('OpenAI API key saved.')
  fireEvent.click(screen.getByText('Clear OpenAI key'))
  expect(getOpenAIAuthStatus().configured).toBe(false)
})
