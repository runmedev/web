import { expect, it } from 'vitest'

import { authorizeReleaseRequest } from './authorizeReleaseRequest'

const identity = { releaseId: 'selected', epoch: 2 }
it('authorizes unregistered clients against the connected worker without settings IO', () => {
  expect(() =>
    authorizeReleaseRequest(identity, { tabId: 'unregistered', epoch: 2 })
  ).not.toThrow()
})
it('rejects missing client identity and obsolete generations before effects', () => {
  for (const request of [
    { epoch: 2 },
    { tabId: 'old', epoch: 1 },
    { tabId: '', epoch: 2 },
  ])
    expect(() => authorizeReleaseRequest(identity, request)).toThrow(
      'before effects'
    )
})
