# Development Style Guide

This document captures repository preferences for writing automation and utility
scripts, especially for CUJ and browser testing.

## Scripting language preference

Use **TypeScript** as the default language for new automation scripts.

### Why TypeScript is preferred

1. Stronger maintainability through types and editor support.
2. Better structure for reusable helpers and error handling.
3. Consistency with the repo's primary stack (React + TypeScript).
4. Easier for contributors to evolve together over time.

## Shell script guidance

- Shell scripts are acceptable as thin wrappers for compatibility.
- Keep wrappers minimal (compile/run entrypoints only).
- Do not put complex scenario logic in shell if a TypeScript driver exists.

## CUJ scripting guidance

For CUJ/browser scripts:

- Keep scenario orchestration in TypeScript.
- Keep each scenario driver focused on one user journey.
- Prefer machine-verifiable assertions (snapshot/text/eval checks).
- Always write diagnostic artifacts to `app/test/browser/test-output/`.
- Add comments explaining intent and failure handling.

## Script quality expectations

- Include doc comments for core helper functions.
- Fail fast on required prerequisites.
- Provide clear PASS/FAIL output for assertions.
- Keep commands deterministic and avoid hidden state where possible.

## Runtime logging

- In app/runtime code, prefer `appLogger` for diagnostics instead of raw
  `console.log` / `console.info` / `console.warn` / `console.error`.
- Emit one structured `appLogger` event per logical occurrence and let the
  logging runtime decide whether that event should also be mirrored to the
  browser console in development.
- Include a stable `attrs.scope` value so logs can be filtered and mirrored
  consistently.
- Avoid duplicating the same event with both `console.*` and `appLogger.*`
  unless there is a clear, documented reason.

## Runme docs notebook format

- Default format for Runme documentation notebooks is JSON notebook files (for example `docs/<name>.json`), not markdown `.runme.md`.
- When adding notebook-based walkthroughs under `docs/`, create/update the JSON notebook directly.
- Use markdown cells inside the JSON notebook for narrative instructions and code cells for runnable steps.

## Secret input pattern

- Use `app/src/components/SecretInput.tsx` for passwords, vault passphrases, API keys, tokens, and other single-line secret entry fields in new or changed UI.
- Mask by default with `type="password"`. Include a right-aligned eye button to show the text and a crossed-out eye to hide it again. Keep enough input padding so the button never covers the value.
- Give each field a visible label. The toggle must be keyboard accessible, use `type="button"` so it cannot submit a form, and announce a field-specific action (for example, “Show key value” / “Hide key value”) with `aria-pressed` and `aria-controls`.
- Visibility is local to each field. Clear or unmount the input to reset masking; reset it when switching records or completing a form. Never persist the visibility choice, log the value, or copy it into notebook output. Revealing affects presentation only, not vault encryption or storage.
- Disable spelling corrections and capitalization for secrets; preserve the appropriate password-manager autocomplete value. An explicit Edit action in an unlocked vault may populate the current secret in the trusted editor, masked by default. Reopening a record must reset visibility. Do not expose saved plaintext through notebook APIs, lists, logs, or serialized output.
