import {
  getDocumentationMarkdown,
  listDocumentationSummaries,
} from '../documentation'
import type { RunmeVersionInfo } from '../versionInfo'

type JsonRecord = Record<string, unknown>

export const LIST_DOCUMENTATION_TOOL_NAME = 'listDocumentation'
export const LIST_DOCUMENTATION_TOOL_TITLE = 'List Runme Documentation'
export const LIST_DOCUMENTATION_TOOL_DESCRIPTION =
  'Codex, Claude, and other AI agents should invoke this read-only function to discover the Runme documentation available for this exact app version. It returns a compact JSON list of document names and descriptions; use getDocumentation to read only the pages needed for the task.'

export const GET_DOCUMENTATION_TOOL_NAME = 'getDocumentation'
export const GET_DOCUMENTATION_TOOL_TITLE = 'Get Runme Documentation'
export const GET_DOCUMENTATION_TOOL_DESCRIPTION =
  'Codex, Claude, and other AI agents should invoke this read-only function with a name returned by listDocumentation to get that Runme documentation page as Markdown.'

export function buildListDocumentationInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
}

export function buildGetDocumentationInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  }
}

export function listDocumentationForAgents(info?: RunmeVersionInfo): string {
  return JSON.stringify(listDocumentationSummaries(info), null, 2)
}

export async function getDocumentationForAgents(
  name: string,
  info?: RunmeVersionInfo,
  fetchImpl?: typeof fetch
): Promise<string> {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(
      'getDocumentation requires a non-empty name returned by listDocumentation.'
    )
  }
  return getDocumentationMarkdown(name, info, fetchImpl)
}
