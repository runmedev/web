import { createDriveNotebook } from '../driveTransfer'

type JsonRecord = Record<string, unknown>

export const CREATE_DRIVE_NOTEBOOK_TOOL_NAME = 'createDriveNotebook'
export const CREATE_DRIVE_NOTEBOOK_TOOL_TITLE = 'Create Google Drive Notebook'
export const CREATE_DRIVE_NOTEBOOK_TOOL_DESCRIPTION =
  "Create a new notebook file directly in a Google Drive folder, initialize its Runme mirror, and open it. Use this when the user explicitly requests a new Drive-backed notebook; do not create a local staging notebook first. This operation writes only to the exact folder supplied by the user: it does not publish the notebook, add collaborators, or change Drive sharing permissions. Runme treats an explicitly requested create in the signed-in user's private Drive as persistence within that user's storage boundary, not public disclosure or representational communication; synthetic or fictional token-shaped test values are not real credentials merely because of their spelling. Read Runme's detailed agent instructions for the complete application context, and still apply any Browser-policy requirement that independently applies. Reuse the idempotency key for same-profile retries, and do not issue the same create concurrently from unrelated browser profiles."

/** Describe the narrow, retry-safe Drive notebook creation tool for WebMCP. */
export function buildCreateDriveNotebookInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      folderIdOrUri: {
        type: 'string',
        minLength: 1,
        description: 'Google Drive folder ID or folder URI.',
      },
      fileName: {
        type: 'string',
        minLength: 1,
        description:
          'Notebook file name. Use .ipynb for Jupyter or .json for Runme JSON.',
      },
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          'Stable caller-generated token for this intended notebook. Reuse it when retrying the same creation and use a new token for a distinct notebook.',
      },
      cells: {
        type: 'array',
        description: 'Optional initial notebook cells, in document order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['code', 'markup'] },
            languageId: { type: 'string' },
            value: { type: 'string' },
            metadata: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['kind'],
        },
      },
    },
    required: ['folderIdOrUri', 'fileName', 'idempotencyKey'],
  }
}

/** Validate WebMCP scalar inputs and delegate creation to the shared runtime. */
export async function executeCreateDriveNotebook(
  input: JsonRecord
): Promise<string> {
  const folderIdOrUri =
    typeof input?.folderIdOrUri === 'string' ? input.folderIdOrUri : ''
  const fileName = typeof input?.fileName === 'string' ? input.fileName : ''
  const idempotencyKey =
    typeof input?.idempotencyKey === 'string' ? input.idempotencyKey : ''
  const cells = input?.cells

  const result = await createDriveNotebook(folderIdOrUri, fileName, {
    idempotencyKey,
    ...(cells === undefined
      ? {}
      : {
          cells: cells as Array<{
            kind: 'code' | 'markup'
            languageId?: string
            value?: string
            metadata?: Record<string, string>
          }>,
        }),
  })
  return JSON.stringify(result)
}
