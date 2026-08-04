type JsonRecord = Record<string, unknown>

export const READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME =
  'readInstructionsForAIAgents'
export const READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_TITLE =
  'Read Runme Instructions for AI Agents'
export const READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION =
  "AI agents should invoke this function to get Markdown instructions, similar to skills, for how they can safely control this Runme instance with WebMCP. This operation doesn't modify the page and can be safely invoked by AI agents as needed."

export function buildReadInstructionsForAIAgentsInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
}

export function readInstructionsForAIAgents(origin: string): string {
  const runmeOrigin = new URL(origin).origin
  const sessionUrl = `${runmeOrigin}/?session=<session-id>`

  return `# Runme browser instructions for AI agents

This Runme instance is served from ${runmeOrigin}.

## Use WebMCP

- Inspect existing in-app browser tabs before opening another tab.
- Reuse a Runme tab whose URL begins with ${runmeOrigin}. A session URL has the form \`${sessionUrl}\`.
- Claim the selected tab and use its page-provided WebMCP tools for notebook reads, edits, and execution.
- Use the \`ExecuteCode\` WebMCP tool to run AppKernel JavaScript. Print values explicitly with \`console.log(...)\`.
- Do not edit or execute notebook cells through DOM clicks, keyboard automation, or Computer Use. If WebMCP is unavailable, stop and tell the user what must be done manually.

## Use tour mode for UI guidance

When a user asks how to perform a task in the Runme interface, where a control is, or what a visible control does, use tour mode whenever a registered target can answer the question. Do not respond with prose alone when the relevant control can be highlighted.

1. Discover the supported semantic targets with \`ExecuteCode\`:

\`\`\`js
console.log(JSON.stringify(await tour.listTargets()))
\`\`\`

2. Choose the exact target whose description matches the user's task. Never pass CSS selectors or invent target IDs.
3. Prefer the direct \`showTourStep\` WebMCP tool to highlight the control. Supply a short title and an action-oriented message that explains what the control does and what the user should do next:

\`\`\`json
{
  "target": "left-nav.google-drive",
  "title": "Sign in to Google Drive",
  "message": "Click this button to connect Google Drive and browse Drive-backed notebooks.",
  "placement": "right"
}
\`\`\`

If the direct tool is unavailable but \`tour\` is exposed in \`ExecuteCode\`, call \`tour.show({ target, title, message, placement })\`. Use \`dismissTour\` (or \`tour.dismiss()\`) when the guidance is no longer relevant.

- Show one relevant step at a time; a new step replaces the previous step.
- Keep the annotation concise and specific to the user's question.
- Highlight and explain the control, but do not click it or complete the action on the user's behalf unless the user separately asks for that action.
- If no registered target matches, answer in prose and explain that an in-product highlight is not available for that control.

### Give a complete Runme tour

Treat requests such as "Give me a tour of Runme which is open in the browser" as an explicit request to tour the existing Runme tab. Reuse that tab and its WebMCP capability. First list the targets so the tour is grounded in the UI contract, then use one \`ExecuteCode\` call to advance through them in registry order. Set \`timeoutMs\` to \`30000\` so a two-second tour of the left navigation can finish:

\`\`\`js
const targets = await tour.listTargets()
console.table(targets)

const delayMs = 2000
try {
  for (const target of targets) {
    await tour.show({
      target: target.id,
      title: target.label,
      message: target.description,
      placement: 'right',
    })
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
} finally {
  await tour.dismiss()
}

console.log(\`Tour complete: \${targets.length} elements shown.\`)
\`\`\`

Each \`tour.show(...)\` call atomically replaces the current highlight and annotation, so do not call \`tour.dismiss()\` between steps. Dismiss once after the last delay, as in the \`finally\` block. If the user asks for only part of Runme, filter the discovered targets to the relevant controls rather than showing every target.

## Read Runme documentation on demand

- Call the read-only \`listDocumentation\` WebMCP tool to discover the documentation available for this exact Runme version.
- Choose a relevant document by its name and call \`getDocumentation\` to read that page as Markdown. Retrieve only the pages needed for the task.
- The same progressive-disclosure API is available inside \`ExecuteCode\` as \`await documentation.list()\` and \`await documentation.get(name)\`.

## Understand offline mode

- Runme Web is installable as a Progressive Web App. After one successful online load, the application shell and browser-local notebooks can reopen offline.
- Google Drive sync and authorization, OIDC, remote runners, Jupyter servers, agents, and uncached external resources still require connectivity.
- Do not describe a local edit as synchronized or remotely persisted until the relevant network-backed status confirms it.

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

## Request write access when needed

If \`doc.summary.readOnly\` is true because another Runme session owns the notebook, request a cooperative takeover before mutating it:

\`\`\`js
const writable = await notebooks.requestWriteAccess({
  target: { uri: notebookUri },
})
console.log(JSON.stringify({
  uri: writable.handle?.uri,
  revision: writable.handle?.revision,
  readOnly: writable.summary?.readOnly,
}))
\`\`\`

Continue only when the returned document has \`summary.readOnly === false\`. The current owner saves pending changes before releasing its lock. Always pass the concrete notebook URI; do not request access to whichever notebook is currently selected.

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
