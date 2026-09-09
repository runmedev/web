/** Flush and bind a draft to exactly the state visible when composition started.
 * Any edit/sync during the flush fails closed; later sends retain these heads.
 */
export async function captureCommentSnapshot(data: {
  getNotebook: () => { cells: unknown[] }
  flushPendingPersist?: () => Promise<unknown>
  getObservedOperationHeads?: () => string[] | undefined
}): Promise<string[]> {
  const visible = JSON.stringify(data.getNotebook().cells)
  await data.flushPendingPersist?.()
  if (JSON.stringify(data.getNotebook().cells) !== visible) {
    throw new Error(
      'The notebook changed while capturing the comment. Select the text or cell again.'
    )
  }
  const heads = data.getObservedOperationHeads?.()
  if (!heads)
    throw new Error(
      'The displayed notebook revision is unavailable. Reopen the notebook before commenting.'
    )
  return heads.slice()
}
