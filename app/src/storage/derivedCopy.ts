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
 * Profiles coordinate a shared identity with client-side checks of a public
 * property. This is best-effort coordination, not an atomic election.
 * r = reserved ID, f = confirmed ID, p = unconfirmed Shared Drive POST. Claims include the source hash so copied metadata is re-elected.
 * A caller must observe its own p claim before issuing that POST.
 */
export async function ensureDerivedCopy(
  drive: DriveNotebookStore,
  sourceUri: string,
  parentUri: string,
  name: string,
  content: () => Promise<string | null>
): Promise<NotebookStoreItem | null> {
  const sourceHash = md5(driveFileUrl(parseDriveItem(sourceUri).id))
  const operationId = `runme-ipynb-${sourceHash}`
  let ownedPending: string | undefined
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claim = await drive.getDerivedCopyClaim(sourceUri)
    if (claim && !/^[rfp]:[a-f0-9]{32}:[A-Za-z0-9_-]+$/.test(claim)) {
      throw new Error(
        'Invalid Colab copy coordination property on the source notebook.'
      )
    }
    if (claim && claim.split(':')[1] !== sourceHash) {
      // Drive copies custom properties. Detach the inherited identity without
      // touching the original notebook's copy (including pending reservations).
      await drive.updateDerivedCopyClaimAfterCheck(sourceUri, claim, null)
      continue
    }
    let target: NotebookStoreItem | null = null
    if (claim?.startsWith('r:') || claim?.startsWith('f:')) {
      target = await drive.getDerivedCopyTarget(
        driveFileUrl(claim.split(':')[2]),
        operationId
      )
    } else {
      // A source can move while its create is unconfirmed. Search by its
      // source-scoped identity across folders, then move the recovered target.
      const found = await drive.waitForCreateOperation(null, operationId)
      if (found)
        target = await drive.getDerivedCopyTarget(found.uri, operationId)
    }
    if (target) {
      const confirmed = `f:${sourceHash}:${parseDriveItem(target.uri).id}`
      if (
        claim === confirmed ||
        (await drive.updateDerivedCopyClaimAfterCheck(
          sourceUri,
          claim,
          confirmed
        ))
      )
        return target
      continue
    }
    if (!claim || claim.startsWith('f:')) {
      const next = (await drive.canUsePreGeneratedFileId(parentUri))
        ? `r:${sourceHash}:${await drive.generateFileId()}`
        : `p:${sourceHash}:${uuidv4()}`
      if (
        await drive.updateDerivedCopyClaimAfterCheck(sourceUri, claim, next)
      ) {
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
        await drive.updateDerivedCopyClaimAfterCheck(sourceUri, claim, null)
      return null
    }
    // Recheck after asynchronous serialization, as another profile can change
    // the claim while we prepare bytes. The final read/POST gap still exists.
    if ((await drive.getDerivedCopyClaim(sourceUri)) !== claim) continue
    try {
      target = await drive.createContent(
        parentUri,
        name,
        bytes,
        IPYNB_MIME_TYPE,
        {
          createOperationId: operationId,
          ...(claim.startsWith('r:') ? { fileId: claim.split(':')[2] } : {}),
        }
      )
    } catch (error) {
      if (error instanceof DriveCreateNotCommittedError) {
        await drive.updateDerivedCopyClaimAfterCheck(sourceUri, claim, null)
      } else if (claim.startsWith('p:')) {
        throw new UnconfirmedDerivedCopyError(claim)
      }
      throw error
    }
    const confirmed = `f:${sourceHash}:${parseDriveItem(target.uri).id}`
    if (
      await drive.updateDerivedCopyClaimAfterCheck(sourceUri, claim, confirmed)
    )
      return target
    // Another profile changed the claim. Reread before further actions.
  }
  throw new Error(
    'Colab copy coordination changed repeatedly; retry Drive sync.'
  )
}
