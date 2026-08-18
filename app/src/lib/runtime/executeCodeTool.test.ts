import { describe, expect, it } from 'vitest'

import {
  EXECUTE_CODE_TOOL_DESCRIPTION,
  buildExecuteCodeInputSchema,
} from './executeCodeTool'

describe('ExecuteCode tool contract', () => {
  it('keeps the live notebook read API next to code generation', () => {
    expect(EXECUTE_CODE_TOOL_DESCRIPTION).toContain('notebooks.get({ uri })')
    expect(EXECUTE_CODE_TOOL_DESCRIPTION).toContain('doc.notebook.cells')
    expect(EXECUTE_CODE_TOOL_DESCRIPTION).toContain(
      'notebooks.read is not an API'
    )
    expect(EXECUTE_CODE_TOOL_DESCRIPTION).toContain('notebooks.help()')

    const schema = buildExecuteCodeInputSchema() as {
      properties: { code: { description?: string } }
    }
    expect(schema.properties.code.description).toContain(
      'notebooks.get({ uri })'
    )
    expect(schema.properties.code.description).toContain('doc.notebook.cells')
    expect(schema.properties.code.description).toContain(
      'Do not call notebooks.read'
    )
  })
})
