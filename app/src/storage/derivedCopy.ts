import md5 from 'md5'
import { v4 as uuidv4 } from 'uuid'

import { IPYNB_MIME_TYPE } from '../lib/ipynb'
import {
  DriveCreateNotCommittedError,
  type DriveNotebookStore,
  driveFileUrl,
  parseDriveItem,
} from './drive'
import type { NotebookStoreItem } from './notebook'

/** Shared Drive POSTs cannot be safely retried without an explicit recovery decision. */
export class UnconfirmedDerivedCopyError extends Error {
  constructor(readonly claim: string) {
    super(
      'Colab copy creation is awaiting Drive confirmation. If it persists, check Drive and use Retry unconfirmed creation in Notebook properties.'
    )
  }
}

/**
 * All profiles elect one identity using the source file's conditional public
 * property update. r = reserved ID, f = confirmed ID, p = unconfirmed Shared
 * Drive POST. Only the call that wins a p claim may issue that POST.
 */
export async function ensureDerivedCopy(
  drive: DriveNotebookStore,
  sourceUri: string,
  parentUri: string,
  name: string,
  content: () => Promise<string | null>
): Promise<NotebookStoreItem | null> {
  const operationId = `runme-ipynb-${md5(driveFileUrl(parseDriveItem(sourceUri).id))}`
  let ownedPending: string | undefined
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claim = await drive.getDerivedCopyClaim(sourceUri)
    if (claim && !/^[rfp]:[A-Za-z0-9_-]+$/.test(claim)) {
      throw new Error(
        'Invalid Colab copy coordination property on the source notebook.'
      )
    }
    let target: NotebookStoreItem | null = null
    if (claim?.startsWith('r:') || claim?.startsWith('f:')) {
      target = await drive.getDerivedCopyTarget(
        driveFileUrl(claim.slice(2)),
        operationId
      )
    } else {
      const found = await drive.waitForCreateOperation(parentUri, operationId)
      if (found)
        target = await drive.getDerivedCopyTarget(found.uri, operationId)
    }
    if (target) {
      const confirmed = `f:${parseDriveItem(target.uri).id}`
      if (
        claim === confirmed ||
        (await drive.compareAndSetDerivedCopyClaim(sourceUri, claim, confirmed))
      )
        return target
      continue
    }
    if (!claim || claim.startsWith('f:')) {
      const next = (await drive.canUsePreGeneratedFileId(parentUri))
        ? `r:${await drive.generateFileId()}`
        : `p:${uuidv4()}`
      if (await drive.compareAndSetDerivedCopyClaim(sourceUri, claim, next)) {
        if (next.startsWith('p:')) ownedPending = next
      }
      continue
    }
    if (claim.startsWith('p:') && ownedPending !== claim) {
      throw new UnconfirmedDerivedCopyError(claim)
    }
    const bytes = await content()
    if (bytes === null) {
      if (ownedPending === claim)
        await drive.compareAndSetDerivedCopyClaim(sourceUri, claim, null)
      return null
    }
    try {
      target = await drive.createContent(
        parentUri,
        name,
        bytes,
        IPYNB_MIME_TYPE,
        {
          createOperationId: operationId,
          ...(claim.startsWith('r:') ? { fileId: claim.slice(2) } : {}),
        }
      )
    } catch (error) {
      if (error instanceof DriveCreateNotCommittedError) {
        await drive.compareAndSetDerivedCopyClaim(sourceUri, claim, null)
      } else if (claim.startsWith('p:')) {
        throw new UnconfirmedDerivedCopyError(claim)
      }
      throw error
    }
    const confirmed = `f:${parseDriveItem(target.uri).id}`
    if (await drive.compareAndSetDerivedCopyClaim(sourceUri, claim, confirmed))
      return target
    // Another source save can change its ETag. Reread before further actions.
  }
  throw new Error(
    'Colab copy coordination changed repeatedly; retry Drive sync.'
  )
}
