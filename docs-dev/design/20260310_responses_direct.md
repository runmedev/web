# Direct Responses Backend in Web App

## Summary

Add a third ChatKit harness adapter: `responses-direct`.

`responses-direct` keeps ChatKit in the browser but moves ChatKit-to-Responses conversion into the web app, instead of going through Runme server `/chatkit`.

This mirrors the Codex adapter architecture:

- ChatKit UI stays unchanged.
- A browser fetch shim translates ChatKit request types to backend protocol calls.
- The shim translates backend stream events back into ChatKit stream events.

## Goals

- Support a direct OpenAI Responses path with no Runme chatkit proxy.
- Keep existing `responses` and `codex` harnesses intact.
- Reuse App Console configuration UX.
- Support two auth modes currently used by Go server behavior:
  - OAuth access token (ChatGPT sign-in token)
  - API key
- Support vector store configuration for Responses file search.

## Non-Goals

- Replacing Codex integration.
- Migrating existing Runme `/chatkit` server integration.
- Persisting full multi-session chat history server-side for direct mode.

## Harness Routing

`HarnessAdapter` now supports:

- `responses` -> `/<base>/chatkit` (existing Runme server path)
- `codex` -> `/<base>/codex/chatkit` (existing Codex adapter path)
- `responses-direct` -> `/<base>/responses/direct/chatkit` (local fetch shim route target)

For `responses-direct`, ChatKit calls still go through `api.fetch`, but the fetch implementation is browser-owned and sends OpenAI requests directly to `https://api.openai.com/v1/responses`.

## Config Model

`app-configs.yaml` now supports OpenAI direct Responses settings under `agent.openai`:

```yaml
agent:
  openai:
    authMethod: OAuth # OAuth or APIKey
    organization: org_xxx
    project: proj_xxx
    vectorStores: [vs_1, vs_2]
```

Compatibility parsing also accepts Go-style fields:

- `openai.organization`
- `openai.project`
- `openai.authMethod`
- `cloudAssistant.vectorStores`

## Auth Behavior

### OAuth mode

- Uses browser ChatGPT OAuth access token.
- Sends:
  - `Authorization: Bearer <access_token>`
  - `OpenAI-Organization: <organization>`
  - `OpenAI-Project: <project>`
- Organization + project are required.

### API key mode

- Uses API key from browser local storage.
- Sends:
  - `Authorization: Bearer <api_key>`
- Does not require ChatGPT sign-in token.

## Local Storage and App Console

Add `runme/responses-direct-config` local storage state:

- `authMethod`
- `openaiOrganization`
- `openaiProject`
- `vectorStores`
- `apiKey`

App Console/API commands:

- `app.responsesDirect.get()`
- `app.responsesDirect.setAuthMethod("OAuth" | "APIKey")`
- `app.responsesDirect.setOpenAIOrganization("org_...")`
- `app.responsesDirect.setOpenAIProject("proj_...")`
- `app.responsesDirect.setVectorStores(["vs_..."])`
- `app.responsesDirect.setAPIKey("sk-...")`
- `app.responsesDirect.clearAPIKey()`

Credential shorthand:

- `credentials.openai.*` mirrors the same setters/getter.

## Stream Conversion

For `threads.create` / `threads.add_user_message`:

1. Emit ChatKit user events (`thread.item.added` + `thread.item.done`).
2. Call OpenAI Responses streaming API.
3. Convert Responses events to ChatKit events:
   - `response.created` -> `aisre.chatkit.state` (thread + previousResponseId)
   - `response.output_item.added` -> assistant `thread.item.added` + content-part-added
   - `response.output_text.delta` -> assistant text delta update
   - `response.output_item.done` -> assistant content-part-done
   - `response.function_call_arguments.done` -> `thread.item.done` client tool call
   - `response.completed` -> `thread.item.done` end_of_turn

For `threads.add_client_tool_output`:

- Build a follow-up Responses request with `function_call_output` and `previous_response_id`.

## Testing Strategy

- Unit tests for local config manager persistence/defaults.
- Unit tests for direct fetch shim request mapping + auth header selection + SSE conversion.
- Existing ChatKitPanel harness-routing tests extended for `responses-direct`.
- Existing Codex and Responses harness tests remain unchanged.
