---
name: environment
title: Environment variables
description: Configure browser-local variables and read OpenAI organization and project IDs from JavaScript cells.
order: 23
---

# Environment variables

Open **Environment** (the table icon) in the left navigation. Add a name and
value, then select **Add variable**. The table supports **Edit**, **Save changes**,
**Cancel**, and **Delete**. Names use letters, numbers, and underscores and start
with a letter or underscore. Names are case-sensitive; values are stored as
strings, including empty values and whitespace. Duplicate names must be edited.

For OpenAI requests, add `OPENAI_ORG_ID` with your organization ID and
`OPENAI_PROJECT_ID` with your project ID. In a **JS → browser** cell:

```javascript
const headers = {
  'OpenAI-Organization': localStorage.getItem('runme.env.OPENAI_ORG_ID'),
  'OpenAI-Project': localStorage.getItem('runme.env.OPENAI_PROJECT_ID'),
}
if (!headers['OpenAI-Organization'] || !headers['OpenAI-Project']) {
  throw new Error('Set OPENAI_ORG_ID and OPENAI_PROJECT_ID in Environment first.')
}
console.log(headers)
```

Pass these headers alongside your authorization header on the relevant API
requests. Environment does not automatically configure Agents API requests.
The [executable notebook](./environment.json) contains the same example.

Each variable is stored in `localStorage` under `runme.env.<NAME>`. This namespace
keeps the table separate from authentication and application settings. You can
also write those keys from browser JS; select **Refresh variables** to see changes
made in the same tab. Changes from other tabs appear automatically.

Values persist across reloads and are shared by notebooks on the same Runme
origin in this browser profile. They are not included in notebook files or Drive
sync. Different Runme origins have separate values. Clearing site data removes
them. These are browser values, not shell environment variables; Python runners
and sandbox JS cannot directly read the host's localStorage.

Values are unencrypted and readable by scripts on this origin. Use **Key Vault**
for API keys and tokens; Environment is for configuration such as IDs and URLs.
