// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  basename: '/runme',
  handleCallback: vi.fn(async () => {}),
}))
vi.mock('../browserAdapter.client', () => ({
  getBrowserAdapter: () => ({ handleCallback: mocks.handleCallback }),
}))
vi.mock('../auth/oidcWindow', () => ({ relayOidcWindowCallback: () => false }))
vi.mock('../lib/appBase', () => ({
  APP_ROUTE_PATHS: { home: '/' },
  getAppRouterBasename: () => mocks.basename,
}))
import Callback from './callback'
import { getOidcReturnRoute } from '../auth/oidcNavigation'

beforeEach(() => {
  sessionStorage.clear()
  mocks.basename = '/runme'
  mocks.handleCallback.mockClear()
})
function Destination() {
  const location = useLocation()
  return <p>{location.pathname + location.search + location.hash}</p>
}
it('returns to the original route without duplicating a non-root basename', async () => {
  sessionStorage.setItem(
    'oidc_login_return',
    '/runme/runs?session=test-session#cell-3'
  )
  render(
    <MemoryRouter basename="/runme" initialEntries={['/runme/oidc/callback']}>
      <Routes>
        <Route path="/oidc/callback" element={<Callback />} />
        <Route path="/runs" element={<Destination />} />
      </Routes>
    </MemoryRouter>
  )
  expect(
    await screen.findByText('/runs?session=test-session#cell-3')
  ).toBeTruthy()
  expect(sessionStorage.getItem('oidc_login_return')).toBeNull()
})
it.each([
  ['/runme/?session=one#cell', '/?session=one#cell'],
  ['/runme?session=one', '/?session=one'],
  ['/runme/runs?doc=a%2Fb#cell', '/runs?doc=a%2Fb#cell'],
  ['/runme-other/runs', '/'],
  ['/outside', '/'],
  ['//evil.example/runme', '/'],
  ['/\\evil.example/runme', '/'],
  ['https://evil.example/runme', '/'],
  [null, '/'],
])('normalizes return destination %s', (path, expected) => {
  expect(getOidcReturnRoute(path)).toBe(expected)
})
it('preserves root-mounted paths, query parameters and fragments', () => {
  mocks.basename = '/'
  expect(getOidcReturnRoute('/runs?session=test#cell')).toBe(
    '/runs?session=test#cell'
  )
})
