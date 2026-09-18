// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OpenAISettings } from './OpenAISettings'
import { getOpenAIAuthStatus, saveOpenAIAuth } from '../../lib/openaiTraining'

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

it('reveals a saved key only on request without making it a replacement draft', () => {
  saveOpenAIAuth('saved-test-key', 'https://api.openai.com/v1')
  const { unmount } = render(<OpenAISettings />)
  const input = screen.getByLabelText('OpenAI API key') as HTMLInputElement
  const save = screen.getByRole('button', {
    name: 'Save OpenAI key',
  }) as HTMLButtonElement
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Show OpenAI key' }))
  expect(input.type).toBe('text')
  expect(input.value).toBe('saved-test-key')
  expect(save.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Hide OpenAI key' }))
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Show OpenAI key' }))
  unmount()
  render(<OpenAISettings />)
  const reopened = screen.getByLabelText('OpenAI API key') as HTMLInputElement
  expect(reopened.type).toBe('password')
  expect(reopened.value).toBe('')
})

it('preserves a replacement when toggling visibility and hides it after saving', () => {
  saveOpenAIAuth('saved-test-key', 'https://api.openai.com/v1')
  render(<OpenAISettings />)
  const input = screen.getByLabelText('OpenAI API key') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'replacement-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show OpenAI key' }))
  expect(input.value).toBe('replacement-test-key')
  expect(input.type).toBe('text')
  fireEvent.click(screen.getByRole('button', { name: 'Hide OpenAI key' }))
  expect(input.value).toBe('replacement-test-key')
  expect(input.type).toBe('password')
  fireEvent.click(screen.getByRole('button', { name: 'Show OpenAI key' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }))
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Show OpenAI key' }))
  expect(input.value).toBe('replacement-test-key')
  fireEvent.click(screen.getByRole('button', { name: 'Clear OpenAI key' }))
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
  expect(
    (
      screen.getByRole('button', {
        name: 'Show OpenAI key',
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true)
})

it('can hide an empty draft even when no key is saved', () => {
  render(<OpenAISettings />)
  const input = screen.getByLabelText('OpenAI API key') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'draft-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show OpenAI key' }))
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hide OpenAI key' }))
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
})
