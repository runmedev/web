// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let runnersState: { name: string; endpoint: string; reconnect: boolean }[] = []
let defaultRunnerName: string | null = null

vi.mock('../contexts/RunnersContext', () => ({
  useRunners: () => ({
    defaultRunnerName,
    listRunners: () => runnersState,
  }),
}))

import { RunnerStatusTab } from './RunnerStatusTab'

describe('RunnerStatusTab', () => {
  beforeEach(() => {
    runnersState = []
    defaultRunnerName = null
  })

  it('shows configured runner availability in a table', () => {
    defaultRunnerName = 'default'
    runnersState = [
      {
        name: 'default',
        endpoint: 'ws://localhost:8080/ws',
        reconnect: true,
      },
    ]

    render(<RunnerStatusTab />)

    expect(screen.getByText('Notebook Runner Status')).toBeTruthy()
    expect(
      screen.getByText('1 runner is available for notebook execution.')
    ).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Endpoint' })).toBeTruthy()
    expect(screen.getByText('ws://localhost:8080/ws')).toBeTruthy()
    expect(screen.getByText('Enabled')).toBeTruthy()
  })

  it('shows unavailable state when no runner endpoint is configured', () => {
    defaultRunnerName = 'default'
    runnersState = [{ name: 'default', endpoint: '', reconnect: true }]

    render(<RunnerStatusTab />)

    expect(
      screen.getByText(
        'No backend runners are available for notebook execution.'
      )
    ).toBeTruthy()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText('No endpoint configured')).toBeTruthy()
  })
})
