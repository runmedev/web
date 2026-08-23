import type { SharedNotebookPreflight } from '../storage/drive'

const TRUST_STORAGE_KEY = 'runme/shared-notebook-trust/v1'
const TRUSTED_DRIVES_STORAGE_KEY = 'runme/shared-notebook-trusted-drives/v1'

const CONSUMER_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
])

export type SharedNotebookTrustBasis =
  | 'explicit_document'
  | 'owned_by_me'
  | 'same_domain'
  | 'trusted_drive'

export interface SharedNotebookTrustRecord {
  provider: 'google-drive'
  effectivePrincipal: string
  fileId: string
  basis: SharedNotebookTrustBasis
  subjectFingerprint: string
  trustedAt: string
}

export interface SharedNotebookTrustDecision {
  trusted: boolean
  basis?: SharedNotebookTrustBasis
  reason: string
  effectivePrincipal: string | null
  principalDomain: string | null
  ownerDomains: string[]
  subjectFingerprint: string
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function normalizeGooglePrincipal(
  principal: string | null | undefined
): string | null {
  const normalized = principal?.trim().toLowerCase() ?? ''
  return normalized || null
}

export function emailDomain(email: string | null | undefined): string | null {
  const normalized = normalizeGooglePrincipal(email)
  if (!normalized) {
    return null
  }
  const separator = normalized.lastIndexOf('@')
  if (separator <= 0 || separator === normalized.length - 1) {
    return null
  }
  return normalized.slice(separator + 1)
}

export function isWorkspaceDomain(domain: string | null): domain is string {
  return Boolean(domain && !CONSUMER_EMAIL_DOMAINS.has(domain))
}

function uniqueOwnerDomains(preflight: SharedNotebookPreflight): string[] {
  return Array.from(
    new Set(
      preflight.owners
        .map((owner) => emailDomain(owner.emailAddress))
        .filter((domain): domain is string => Boolean(domain))
    )
  ).sort()
}

export function sharedNotebookSubjectFingerprint(
  preflight: SharedNotebookPreflight
): string {
  if (preflight.driveId) {
    return `drive:${preflight.driveId}`
  }
  const ownerIds = preflight.owners
    .map((owner) => owner.permissionId?.trim())
    .filter((permissionId): permissionId is string => Boolean(permissionId))
    .sort()
  if (ownerIds.length > 0) {
    return `owners:${ownerIds.join(',')}`
  }
  const ownerEmails = preflight.owners
    .map((owner) => normalizeGooglePrincipal(owner.emailAddress))
    .filter((email): email is string => Boolean(email))
    .sort()
  if (ownerEmails.length > 0) {
    return `owner-emails:${ownerEmails.join(',')}`
  }
  return `file:${preflight.fileId}`
}

export function loadSharedNotebookTrustRecords(): SharedNotebookTrustRecord[] {
  const storage = getStorage()
  if (!storage) {
    return []
  }
  try {
    const parsed = JSON.parse(storage.getItem(TRUST_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (record): record is SharedNotebookTrustRecord =>
        record?.provider === 'google-drive' &&
        typeof record.effectivePrincipal === 'string' &&
        typeof record.fileId === 'string' &&
        typeof record.basis === 'string' &&
        typeof record.subjectFingerprint === 'string' &&
        typeof record.trustedAt === 'string'
    )
  } catch {
    return []
  }
}

export function saveSharedNotebookTrustRecord(
  record: SharedNotebookTrustRecord
): void {
  const storage = getStorage()
  if (!storage) {
    return
  }
  const records = loadSharedNotebookTrustRecords().filter(
    (candidate) =>
      !(
        candidate.effectivePrincipal === record.effectivePrincipal &&
        candidate.fileId === record.fileId
      )
  )
  storage.setItem(TRUST_STORAGE_KEY, JSON.stringify([...records, record]))
}

export function rememberSharedNotebookTrust(
  preflight: SharedNotebookPreflight,
  effectivePrincipal: string,
  basis: SharedNotebookTrustBasis
): SharedNotebookTrustRecord {
  const normalizedPrincipal = normalizeGooglePrincipal(effectivePrincipal)
  if (!normalizedPrincipal) {
    throw new Error('A Google Drive principal is required to trust a notebook.')
  }
  const record: SharedNotebookTrustRecord = {
    provider: 'google-drive',
    effectivePrincipal: normalizedPrincipal,
    fileId: preflight.fileId,
    basis,
    subjectFingerprint: sharedNotebookSubjectFingerprint(preflight),
    trustedAt: new Date().toISOString(),
  }
  saveSharedNotebookTrustRecord(record)
  return record
}

export function loadTrustedSharedDriveIds(): string[] {
  const storage = getStorage()
  if (!storage) {
    return []
  }
  try {
    const parsed = JSON.parse(
      storage.getItem(TRUSTED_DRIVES_STORAGE_KEY) ?? '[]'
    )
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

export function evaluateSharedNotebookTrust({
  preflight,
  effectivePrincipal,
  records = loadSharedNotebookTrustRecords(),
  trustedDriveIds = loadTrustedSharedDriveIds(),
}: {
  preflight: SharedNotebookPreflight
  effectivePrincipal: string | null | undefined
  records?: SharedNotebookTrustRecord[]
  trustedDriveIds?: string[]
}): SharedNotebookTrustDecision {
  const principal = normalizeGooglePrincipal(effectivePrincipal)
  const principalDomain = emailDomain(principal)
  const ownerDomains = uniqueOwnerDomains(preflight)
  const subjectFingerprint = sharedNotebookSubjectFingerprint(preflight)

  if (!principal) {
    return {
      trusted: false,
      reason: 'Runme could not identify the effective Google Drive account.',
      effectivePrincipal: null,
      principalDomain: null,
      ownerDomains,
      subjectFingerprint,
    }
  }

  const stored = records.find(
    (record) =>
      record.effectivePrincipal === principal &&
      record.fileId === preflight.fileId &&
      record.subjectFingerprint === subjectFingerprint
  )
  if (stored) {
    return {
      trusted: true,
      basis: stored.basis,
      reason: 'This Google Drive document was previously trusted.',
      effectivePrincipal: principal,
      principalDomain,
      ownerDomains,
      subjectFingerprint,
    }
  }

  if (preflight.ownedByMe) {
    return {
      trusted: true,
      basis: 'owned_by_me',
      reason: 'Google Drive reports that the current account owns this file.',
      effectivePrincipal: principal,
      principalDomain,
      ownerDomains,
      subjectFingerprint,
    }
  }

  if (
    preflight.driveId &&
    trustedDriveIds.some((driveId) => driveId === preflight.driveId)
  ) {
    return {
      trusted: true,
      basis: 'trusted_drive',
      reason: 'This file belongs to an explicitly trusted Shared Drive.',
      effectivePrincipal: principal,
      principalDomain,
      ownerDomains,
      subjectFingerprint,
    }
  }

  if (
    isWorkspaceDomain(principalDomain) &&
    ownerDomains.some((domain) => domain === principalDomain)
  ) {
    return {
      trusted: true,
      basis: 'same_domain',
      reason: `The file owner and current Drive account belong to ${principalDomain}.`,
      effectivePrincipal: principal,
      principalDomain,
      ownerDomains,
      subjectFingerprint,
    }
  }

  return {
    trusted: false,
    reason: preflight.driveId
      ? 'This Shared Drive is not trusted by the current policy.'
      : 'The file owner is outside the current Google Workspace domain or could not be verified.',
    effectivePrincipal: principal,
    principalDomain,
    ownerDomains,
    subjectFingerprint,
  }
}

export {
  TRUST_STORAGE_KEY as SHARED_NOTEBOOK_TRUST_STORAGE_KEY,
  TRUSTED_DRIVES_STORAGE_KEY as TRUSTED_SHARED_DRIVES_STORAGE_KEY,
}
