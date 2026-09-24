// @vitest-environment node
import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

import storageRules from '../../tools/bounded-storage-reads.mjs'

const ruleConfig = {
  plugins: { storage: storageRules },
  rules: { 'storage/bounded-storage-reads': 'error' },
}

describe('bounded storage read guardrail', () => {
  it.each([
    'store.files.toArray()',
    'store.files.where("remoteId").equals("id").toArray()',
    'store.driveCreates.limit(50).toArray()',
    'store["files"].bulkGet(["a", "b"])',
    'db.table("files").primaryKeys()',
    'const table = store.files; table.toArray()',
    'const query = store.driveCreates.where("id"); query.sortBy("name")',
  ])('rejects bypass: %s', (code) => {
    const messages = new Linter().verify(code, ruleConfig)
    expect(messages).toHaveLength(1)
    expect(messages[0].ruleId).toBe('storage/bounded-storage-reads')
  })

  it.each([
    'readTablePage(store.files, row => ({ id: row.id }))',
    'scanTable(store.driveCreates)',
    'store.files.get("id")',
    'store.files.where("remoteId").equals("id").first()',
    'store.folders.toArray()',
  ])('allows bounded or unrelated read: %s', (code) => {
    expect(new Linter().verify(code, ruleConfig)).toEqual([])
  })

  it('keeps production file and creation enumeration behind the helpers', async () => {
    // Run the same rule in the regular app test suite, even when CI skips lint.
    const lint = new ESLint({
      allowInlineConfig: false,
      cwd: new URL('../../', import.meta.url).pathname,
      overrideConfigFile: true,
      overrideConfig: [{ ignores: ['src/**/*.test.*'] }, {
        ...ruleConfig,
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: { parser: tseslint.parser },
      }],
    })
    const results = await lint.lintFiles(['src/**/*.{ts,tsx}'])
    expect(results.flatMap((result) => result.messages.map((message) =>
      `${result.filePath}:${message.line} ${message.message}`
    ))).toEqual([])
  })
})
