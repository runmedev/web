import { describe, expect, it, vi } from 'vitest'

import type { RunmeVersionInfo } from '../versionInfo'
import {
  GET_DOCUMENTATION_TOOL_DESCRIPTION,
  LIST_DOCUMENTATION_TOOL_DESCRIPTION,
  buildGetDocumentationInputSchema,
  buildListDocumentationInputSchema,
  getDocumentationForAgents,
  listDocumentationForAgents,
} from './documentationTools'

const versionInfo: RunmeVersionInfo = {
  buildDate: null,
  webRepo: 'runmedev/web',
  webBranch: 'main',
  webCommit: 'abc123def456',
  bucket: null,
}

describe('documentation WebMCP tools', () => {
  it('returns a compact JSON discovery index', () => {
    const documents = JSON.parse(
      listDocumentationForAgents(versionInfo)
    ) as Array<Record<string, unknown>>

    expect(documents[0]).toEqual({
      name: 'getting-started',
      description:
        'Use this guide when opening Runme for the first time or when an agent needs the shortest path from an unopened notebook to a successful cell execution. It covers prerequisites, opening a notebook, selecting an execution path, running a cell, and checking its output. For detailed runner configuration, use one of the runner-specific guides.',
    })
    expect(documents[0]).not.toHaveProperty('content')
    expect(documents[0]).not.toHaveProperty('uri')
  })

  it('returns one named page as Markdown', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '# Getting Started',
    })) as unknown as typeof fetch

    await expect(
      getDocumentationForAgents('getting-started', versionInfo, fetchImpl)
    ).resolves.toBe('# Getting Started')
  })

  it('rejects missing names before fetching', async () => {
    await expect(getDocumentationForAgents('')).rejects.toThrow(
      'non-empty name returned by listDocumentation'
    )
  })

  it('describes the progressive-disclosure workflow directly', () => {
    expect(LIST_DOCUMENTATION_TOOL_DESCRIPTION).toContain(
      'should invoke this read-only function'
    )
    expect(LIST_DOCUMENTATION_TOOL_DESCRIPTION).toContain(
      'use getDocumentation'
    )
    expect(GET_DOCUMENTATION_TOOL_DESCRIPTION).toContain(
      'name returned by listDocumentation'
    )
  })

  it('defines strict input schemas', () => {
    expect(buildListDocumentationInputSchema()).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    })
    expect(buildGetDocumentationInputSchema()).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    })
  })
})
