# ChatKit and CDP

## Goal

This note documents how to drive the embedded ChatKit UI in local Chrome
through Chrome DevTools Protocol (CDP), including:

- how to enter and submit a prompt,
- how to wait for and read the assistant response.

This is useful when validating notebook-editing behavior end to end against the
`responses-direct` ChatKit harness.

## Attach to the Correct ChatKit Frame

The ChatKit UI is rendered in a cross-origin iframe inside the
`<openai-chatkit>` custom element, so parent-page DOM access is blocked.

Use CDP target discovery instead:

1. Read `http://127.0.0.1:9222/json/list` and select the active Runme page
   target, e.g. the first target with `type === "page"` and
   `url === "http://localhost:5173/"`.
2. Connect to the browser websocket from `http://127.0.0.1:9222/json/version`.
3. Call `Target.getTargets` and select the `iframe` target whose
   `parentFrameId` matches the active page target id and whose URL contains
   `cdn.platform.openai.com/deployments/chatkit`.
4. Connect to that iframe target's `webSocketDebuggerUrl`.
5. Call `Runtime.enable` on the iframe target connection.

This matters when there are multiple `localhost:5173` tabs open. If you attach
to the wrong ChatKit iframe target, notebook state can appear empty or stale.

## Send a Prompt

Send prompts by evaluating JavaScript inside the ChatKit iframe target with
`Runtime.evaluate`.

The method used to enter text is:

- focus the composer element,
- set its value through the native textarea/input setter,
- dispatch bubbling `input` and `change` events,
- click the enabled button whose `aria-label` contains `Send`.

Composer selector:

```js
const composer = document.querySelector(
  '#chatkit-composer-input, textarea, [contenteditable="true"], [role="textbox"]'
)
```

Prompt submission snippet:

```js
(() => {
  const prompt = 'What is runme?'
  const composer = document.querySelector(
    '#chatkit-composer-input, textarea, [contenteditable="true"], [role="textbox"]'
  )
  if (!composer) {
    throw new Error('Composer textbox not found')
  }

  composer.focus()

  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    const setter =
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) {
      setter.call(composer, prompt)
    } else {
      composer.value = prompt
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    composer.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    composer.textContent = prompt
    composer.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: prompt,
      })
    )
  }

  const button = Array.from(document.querySelectorAll('button')).find((el) => {
    const label = (el.getAttribute('aria-label') || '').toLowerCase()
    const disabled =
      el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    return !disabled && label.includes('send')
  })
  if (!button) {
    throw new Error('Send message button not found')
  }
  button.click()
  return true
})()
```

Run that script through CDP with:

```js
await client.send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
})
```

## Start a Fresh Thread

To start from a clean conversation, click the button with
`aria-label="New chat"`, then poll until `document.querySelectorAll('article')`
is empty.

```js
(() => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (el) => el.getAttribute('aria-label') === 'New chat'
  )
  if (!button) {
    throw new Error('New chat button not found')
  }
  button.click()
  return true
})()
```

## Wait for the Assistant Response

Poll iframe DOM state with `Runtime.evaluate` until:

- there are at least two `article` elements,
- the newest assistant article has non-empty text,
- no button with `aria-label` containing `Stop` is present,
- the tuple `(article count, last assistant text, composer value, stop-button state)`
  is unchanged for two consecutive polls.

Polling every 1 second with a 2-consecutive-stable threshold worked reliably in
local testing.

State probe:

```js
(() => {
  const articles = Array.from(document.querySelectorAll('article')).map(
    (article, index) => ({
      index,
      text: (article.innerText || '').trim(),
    })
  )
  const composer = document.querySelector(
    '#chatkit-composer-input, textarea, [contenteditable="true"], [role="textbox"]'
  )
  const stopButton = Array.from(document.querySelectorAll('button')).find((el) =>
    (el.getAttribute('aria-label') || '').toLowerCase().includes('stop')
  )
  return {
    articles,
    composerValue: composer
      ? String(composer.value || composer.textContent || '')
      : null,
    hasStopButton: !!stopButton,
  }
})()
```

## Read the AI Response

Chat turns are represented as `article` elements in the iframe DOM.

Extract transcript text with:

```js
(() => {
  return Array.from(document.querySelectorAll('article')).map(
    (article, index) => ({
      index,
      text: (article.innerText || '').trim(),
    })
  )
})()
```

The assistant message is the last article whose text starts with
`"The assistant said:"`. Strip that prefix if you only need the response body.

## Notes

- Prefer `Runtime.evaluate` against the ChatKit iframe target, not parent-page
  DOM queries, because the iframe is cross-origin.
- If multiple Runme tabs are open, always bind the iframe target by
  `parentFrameId`.
- If the assistant response looks unrelated to the visible notebook state,
  suspect that the CDP client is attached to the wrong ChatKit iframe target
  before debugging application code.
