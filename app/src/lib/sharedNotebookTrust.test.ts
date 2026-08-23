// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import type { SharedNotebookPreflight } from '../storage/drive'
import {
  evaluateSharedNotebookTrust,
  loadSharedNotebookTrustRecords,
  rememberSharedNotebookTrust,
  sharedNotebookSubjectFingerprint,
} from './sharedNotebookTrust'

function preflight(
  overrides: Partial<SharedNotebookPreflight> = {}
): SharedNotebookPreflight {
  return {
    fileId: 'file-1',
    uri: 'https://drive.google.com/file/d/file-1/view',
    name: 'design.ipynb',
    mimeType: 'application/x-ipynb+json',
    parents: [],
    owners: [
      {
        emailAddress: 'owner@acme.example',
        permissionId: 'owner-permission',
      },
    ],
    canDownload: true,
    ...overrides,
  }
}

describe('evaluateSharedNotebookTrust', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('trusts a Workspace-owned file in the same domain', () => {
    expect(
      evaluateSharedNotebookTrust({
        preflight: preflight(),
        effectivePrincipal: 'viewer@acme.example',
        records: [],
        trustedDriveIds: [],
      })
    ).toMatchObject({
      trusted: true,
      basis: 'same_domain',
      principalDomain: 'acme.example',
      ownerDomains: ['acme.example'],
    })
  })

  it('does not treat consumer Gmail addresses as an organization', () => {
    expect(
      evaluateSharedNotebookTrust({
        preflight: preflight({
          owners: [{ emailAddress: 'owner@gmail.com' }],
        }),
        effectivePrincipal: 'viewer@gmail.com',
        records: [],
        trustedDriveIds: [],
      }).trusted
    ).toBe(false)
  })

  it('does not treat third-party consumer email domains as organizations', () => {
    expect(
      evaluateSharedNotebookTrust({
        preflight: preflight({
          owners: [{ emailAddress: 'owner@outlook.com' }],
        }),
        effectivePrincipal: 'viewer@outlook.com',
        records: [],
        trustedDriveIds: [],
      }).trusted
    ).toBe(false)
  })

  it('requires review for an external owner', () => {
    expect(
      evaluateSharedNotebookTrust({
        preflight: preflight({
          owners: [{ emailAddress: 'owner@partner.example' }],
        }),
        effectivePrincipal: 'viewer@acme.example',
        records: [],
        trustedDriveIds: [],
      })
    ).toMatchObject({ trusted: false })
  })

  it('trusts an explicitly allowlisted Shared Drive', () => {
    expect(
      evaluateSharedNotebookTrust({
        preflight: preflight({ driveId: 'drive-1', owners: [] }),
        effectivePrincipal: 'viewer@acme.example',
        records: [],
        trustedDriveIds: ['drive-1'],
      })
    ).toMatchObject({ trusted: true, basis: 'trusted_drive' })
  })

  it('persists explicit document trust and invalidates it on ownership change', () => {
    const original = preflight()
    rememberSharedNotebookTrust(
      original,
      'viewer@acme.example',
      'explicit_document'
    )

    expect(loadSharedNotebookTrustRecords()).toHaveLength(1)
    expect(
      evaluateSharedNotebookTrust({
        preflight: original,
        effectivePrincipal: 'viewer@acme.example',
        trustedDriveIds: [],
      })
    ).toMatchObject({ trusted: true, basis: 'explicit_document' })

    const changedOwner = preflight({
      owners: [
        {
          emailAddress: 'replacement@partner.example',
          permissionId: 'replacement-permission',
        },
      ],
    })
    expect(sharedNotebookSubjectFingerprint(changedOwner)).not.toBe(
      sharedNotebookSubjectFingerprint(original)
    )
    expect(
      evaluateSharedNotebookTrust({
        preflight: changedOwner,
        effectivePrincipal: 'viewer@acme.example',
        trustedDriveIds: [],
      }).trusted
    ).toBe(false)
  })
})
