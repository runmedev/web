# 2026-04-25 Missing Commentary in ChatKit

## Summary

On `http://localhost:5173`, ChatKit could sit on `...` for a long time even though Codex had already started returning textual reasoning commentary through the proxy. The frontend was only surfacing assistant-message deltas, not reasoning-summary deltas, so `TTFM` in the UI could be much larger than `TTFM` in the app server logs.

The fix is to translate Codex reasoning-summary notifications into normal ChatKit streaming events and to log browser-side timing milestones so we can compare UI timing against server timing.

This also clarifies one important distinction:

- If the backend has already emitted reasoning text and the UI still shows `...`, that is a bug.
- If the backend has not emitted any textual event yet, some wait on `...` is expected. The fix does not remove genuine model latency.

## Bug

### Symptom

For complex prompts, Codex often emits reasoning-summary commentary before the final assistant message. Before this fix, those reasoning events were present in the proxy/app-server logs but were not surfaced into ChatKit, so the user saw only `...` until a later assistant delta arrived.

### Root Cause

`codexConversationController.ts` handled:

- `item/agentMessage/delta`
- `item/completed` for assistant messages
- some `response.*` compatibility events

but it ignored reasoning-summary notifications such as:

- `item/reasoning/summaryTextDelta`
- reasoning-shaped `item/completed`
- legacy `reasoning_content_delta`

As a result, the browser did not receive visible streamed text for those events, and `first_visible_message` never fired for them.

## Fix

### Stream reasoning commentary into ChatKit

In [codexConversationController.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.ts:218):

- `extractReasoningSummaryText(...)` joins reasoning summary parts into visible text.

In [codexConversationController.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.ts:1382):

- reasoning `item/completed` is mapped to a ChatKit `done` event
- `item/reasoning/summaryTextDelta` is mapped to a ChatKit `delta` event
- legacy `reasoning_content_delta` is also mapped to a visible delta

This makes reasoning commentary appear through the same `response.output_text.*` path as normal assistant streaming.

### Log browser timing milestones

In [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:293):

- the panel records active turn timing state
- logs `submit`
- logs `response_created`
- logs `first_visible_message`
- logs `completed`
- logs `failed`

The relevant browser-side logging is in [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:400) and [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:852).

These logs are emitted both to the browser console as `[chatkit] timing ...` and through `appLogger`.

## Metrics

### TTFM

`TTFM` = Time To First Message shown to the user.

The first message may be:

- a partial streamed answer
- a reasoning commentary delta
- a completed content part

Browser-side definition:

- `first_visible_message.timestamp - submit.timestamp`

Server-side definition:

- `first textual event timestamp - turn/started.timestamp`

For server-side `TTFM`, the first textual event should be the earliest of:

- `item/reasoning/summaryTextDelta`
- `item/agentMessage/delta`
- any equivalent streamed text event if the protocol changes

### TTT

`TTT` = Total Turn Time.

Browser-side definition:

- `completed.timestamp - submit.timestamp`

Server-side definition:

- `turn/completed.timestamp - turn/started.timestamp`

## How To Measure

### Browser / ChatKit

Open DevTools and filter for:

```text
[chatkit] timing
```

Expected events for a successful turn:

```text
submit
response_created
first_visible_message
completed
```

### App server

For the local `localhost:5173` setup used in this investigation, the relevant log was:

```text
/tmp/runme-agent.openai.dev.log.json
```

Filter by turn id or thread id and look for:

- `turn/start`
- `turn/started`
- first `item/reasoning/summaryTextDelta` or `item/agentMessage/delta`
- `turn/completed`

## Verification

### Complex prompt used to generate commentary

I used this prompt because it reliably causes code search and multi-step reasoning:

```text
Complex timing prompt for commentary verification. Search the runme and web codebases, explain how Jupyter kernels are configured and used in Runme, identify outdated docs, and cite the exact files and lines I should update.
```

### Pre-fix live evidence

Turn:

- thread id: `019dc6ad-6ef4-7910-8a08-781d5208cc85`
- turn id: `019dc6b2-082c-7f21-88c7-40a2fe323b36`

Browser evidence:

- submit logged at `2026-04-25T22:10:49.514Z`
- after roughly 20 to 25 seconds, the UI still showed only `...`
- no browser `first_visible_message` log was observed in that window

Server evidence from `/tmp/runme-agent.openai.dev.log.json`:

- `turn/start` at line `2359`
- `turn/started` at line `2367`
- first `item/reasoning/summaryTextDelta` at line `2373`

Relevant timestamps:

- `turn/started`: `1777155049.525316`
- first reasoning text: `1777155071.062825`

Computed server-side `TTFM`:

```text
1777155071.062825 - 1777155049.525316 = 21.537509s
```

Interpretation:

- the backend had visible commentary after about `21.5s`
- the UI was still stuck on `...`
- therefore the frontend was dropping or suppressing the first visible commentary

### Post-fix automated verification

Controller coverage in [codexConversationController.test.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.test.ts:1569) and [codexConversationController.test.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.test.ts:1664):

- `surfaces commentary-phase deltas before the final answer completes`
- `surfaces reasoning summary deltas before assistant commentary arrives`

Panel timing coverage in [ChatKitPanel.test.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.test.tsx:692):

- `logs codex timing milestones from submit through first streamed text`

Failure-path coverage in [ChatKitPanel.test.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.test.tsx:637):

- `surfaces response.failed SSE events as an in-panel error`

Focused test run result:

```text
2 passed
4 passed | 39 skipped
```

The timing test emitted:

```text
[chatkit] timing {"phase":"submit", ...}
[chatkit] timing {"phase":"response_created","responseId":"turn-timing-1","elapsedMs":0,...}
[chatkit] timing {"phase":"first_visible_message","responseId":"turn-timing-1","eventType":"response.output_text.delta","ttfmMs":1,...}
[chatkit] timing {"phase":"completed","responseId":"turn-timing-1","totalTurnTimeMs":1,...}
```

This verifies that once a streamed text delta reaches ChatKit, the panel records `TTFM` immediately and does not wait for final completion.

### Post-fix live evidence

I also ran another complex prompt after the fix on a fresh local turn:

- thread id: `019dc6b4-e02a-7680-afbb-dec453459b67`
- turn id: `019dc6b5-5f79-7012-9970-34c5e77ea631`

The server log shows reasoning commentary arriving early in the turn:

- first `item/reasoning/summaryTextDelta` at line `2695`
- timestamp `1777155278.525066`

with:

- `turn/start` timestamp `1777155268.472954`

Computed server-side `TTFM`:

```text
1777155278.525066 - 1777155268.472954 = 10.052112s
```

During this run, browser automation was interrupted before I captured the matching post-fix browser `first_visible_message` log for the same turn, so I am not claiming a completed live browser-vs-server parity measurement yet for that exact turn.

What is verified today:

- pre-fix, the backend could emit reasoning commentary while the UI still showed only `...`
- post-fix, the controller now emits those reasoning deltas into ChatKit
- post-fix, the panel logs `first_visible_message` on the first streamed text delta

## Result

The missing-commentary bug is fixed.

After this change:

- reasoning commentary is eligible to become the first visible user-facing text
- ChatKit now records `TTFM` from the first visible streamed delta, not only from the final answer
- we can compare browser timing against server timing using consistent event boundaries

The remaining long wait that you may still see on some prompts is only expected when Codex itself has not emitted any textual reasoning or assistant delta yet.

## Recommended follow-up

Run one more live localhost turn with DevTools open and capture both:

- browser `[chatkit] timing` logs
- matching `/tmp/runme-agent.openai.dev.log.json` entries for the same turn id

For a healthy turn after this fix:

- browser `TTFM` should be close to server `TTFM`
- browser `TTT` should be close to server `TTT`
- differences should be small transport/rendering overhead, not tens of seconds
