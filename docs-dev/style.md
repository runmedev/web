# Development Style Guide

This document captures repository preferences for writing automation and utility
scripts, especially for CUJ and browser testing.

## Scripting language preference

Use **TypeScript** as the default language for new automation scripts.

### Why TypeScript is preferred

1. Stronger maintainability through types and editor support.
2. Better structure for reusable helpers and error handling.
3. Consistency with the repo's primary stack (React + TypeScript).
4. Easier for Codex and humans to evolve together over time.

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

## Runme docs notebook format

- Default format for Runme documentation notebooks is JSON notebook files (for example `docs/<name>.json`), not markdown `.runme.md`.
- When adding notebook-based walkthroughs under `docs/`, create/update the JSON notebook directly.
- Use markdown cells inside the JSON notebook for narrative instructions and code cells for runnable steps.
