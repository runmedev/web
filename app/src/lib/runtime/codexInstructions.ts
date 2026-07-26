type JsonRecord = Record<string, unknown>

export const READ_INSTRUCTIONS_FOR_CODEX_TOOL_NAME = 'readInstructionsForCodex'
export const READ_INSTRUCTIONS_FOR_CODEX_TOOL_TITLE =
  'Read Runme Instructions for Codex'
export const READ_INSTRUCTIONS_FOR_CODEX_TOOL_DESCRIPTION =
  "Codex, Claude, and other AI agents should invoke this function to get Markdown instructions, similar to skills, for how AI agents can safely control this Runme instance with WebMCP. This operation doesn't modify the page and can be safely invoked by AI agents as needed."

export function buildReadInstructionsForCodexInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
}

export function readInstructionsForCodex(origin: string): string {
  const runmeOrigin = new URL(origin).origin
  const sessionUrl = `${runmeOrigin}/?session=<session-id>`

  return `# Runme browser instructions for Codex

This Runme instance is served from ${runmeOrigin}.

## Use WebMCP

- Inspect existing in-app browser tabs before opening another tab.
- Reuse a Runme tab whose URL begins with ${runmeOrigin}. A session URL has the form \`${sessionUrl}\`.
- Claim the selected tab and use its page-provided WebMCP tools for notebook reads, edits, and execution.
- Use the \`ExecuteCode\` WebMCP tool to run AppKernel JavaScript. Print values explicitly with \`console.log(...)\`.
- Do not edit or execute notebook cells through DOM clicks, keyboard automation, or Computer Use. If WebMCP is unavailable, stop and tell the user what must be done manually.

## Read Runme documentation on demand

- Call the read-only \`listDocumentation\` WebMCP tool to discover the documentation available for this exact Runme version.
- Choose a relevant document by its name and call \`getDocumentation\` to read that page as Markdown. Retrieve only the pages needed for the task.
- The same progressive-disclosure API is available inside \`ExecuteCode\` as \`await documentation.list()\` and \`await documentation.get(name)\`.

## Verify the browser session

The URL's \`session\` query parameter identifies a candidate tab. Before changing a notebook, call \`ExecuteCode\` with:

\`\`\`js
console.log(await app.getSessionID())
\`\`\`

Continue only when the printed value matches the selected tab's \`session\` query parameter. If they differ, do not mutate a notebook in that tab.

## Bind the notebook before editing

Resolve the requested notebook once, save its concrete \`local://...\` URI, and use that URI for every later operation. Do not keep targeting whichever notebook happens to be current because the user may switch tabs or notebooks while work is in progress.

\`\`\`js
const initial = await notebooks.get()
const notebookUri = initial.summary?.uri || initial.handle?.uri

if (!notebookUri?.startsWith('local://')) {
  throw new Error(\`Unable to resolve notebook URI: \${notebookUri}\`)
}

const doc = await notebooks.get({ uri: notebookUri })
console.log(JSON.stringify({
  uri: notebookUri,
  revision: doc.handle?.revision,
  name: doc.summary?.name,
}))
\`\`\`

If the user's notebook reference is ambiguous, ask which notebook to use before making a change.

## Make safe notebook changes

- Inspect \`await notebooks.help()\` when helper availability is uncertain.
- Use \`notebooks.appendCell\` for a simple append. A Markdown cell uses \`kind: 'markup'\`, not \`kind: 'markdown'\`.
- Use \`notebooks.update\` for multi-cell or idempotent edits. Pass \`target: { uri: notebookUri }\` and \`expectedRevision: doc.handle.revision\` when a revision is available.
- Prefer updating a stable named cell over blindly appending duplicate status or result cells.
- Build large cell values as data (for example with \`JSON.stringify\`) instead of hand-escaping nested JavaScript.
- Catch and inspect \`NOTEBOOK_UPDATE_FAILED\`; a multi-operation update can partially succeed.

After every mutation, read the same URI again and verify the exact \`refId\`, \`languageId\`, value, and revision that matter to the request:

\`\`\`js
const verified = await notebooks.get({ uri: notebookUri })
console.log(JSON.stringify({
  uri: verified.handle?.uri,
  revision: verified.handle?.revision,
  cells: verified.notebook?.cells,
}))
\`\`\`

Treat the reread result—not the visible selection—as the source of truth.
`
}
