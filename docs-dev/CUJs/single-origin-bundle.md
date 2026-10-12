# Production bundle with one reachable origin

Build with `runme run build test`, then serve the generated artifact:

```sh
pnpm -C app exec vite preview --host 127.0.0.1 --port 5197 --strictPort
```

In another terminal:

```sh
cd app
pnpm exec tsc --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --outDir test/browser/.generated test/browser/single-origin-bundle.ts
CHROMIUM_PATH=/path/to/chrome node test/browser/.generated/single-origin-bundle.js
```

Use a fresh temporary browser context, the production artifact, and the shipped
configuration with external integrations disabled. The driver records request
URLs and screenshots under `app/test/browser/test-output/single-origin-bundle`.
It exercises public WebMCP tools through a test registration adapter; there is no
application test endpoint or fake HTTP backend. DNS blocks external hosts even
for worker traffic; context interception tests immediate and stalled failures.

Acceptance: the app renders, a local notebook can be created and shown, Monaco
loads, built-in help returns Markdown, and Excalidraw renders text and exports PNG/SVG without any external
request. Reload offline and verify the durable notebook bytes and bundled help. Local assets must succeed, not merely return HTML via SPA fallback.
Verify missing fonts stay local. Browser-local writes must remain durable.

The canonical CUJ orchestrator also runs `test-scenario-single-origin-bundle.ts`
against its own production preview. Network reports, screenshots, exported
images and short videos use the existing CUJ artifact publication pipeline.
