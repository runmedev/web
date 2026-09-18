# Unavailable runner and automatic recovery

## User journey

1. Run a Bash cell against a configured runner address with no listening server.
2. See a **Runner unavailable** alert in that cell, with actionable connection guidance.
3. Do not see the **Provide input** control while disconnected.
4. Start the runner without rerunning the cell. The alert clears after the protocol handshake.
5. The queued command executes. Send stdin and observe its real output and exit code.

## Automated verification

`app/test/browser/test-scenario-runner-unavailable.ts` uses the app's registered
WebMCP handlers to create and execute a local `.runme` notebook. It first targets
a free loopback port with no listener, then starts the real Go Runme agent at
that address. It verifies the same run ID survives recovery, stdout includes the
submitted input, and connection diagnostics never become saved output or fake
exit codes. The isolated runner is stopped during cleanup.

Screenshots `scenario-runner-unavailable-error.png` and
`scenario-runner-unavailable-recovered.png`, plus a video, are captured under
`app/test/browser/test-output/` and uploaded by the existing CI artifact pipeline.

Run with `CUJ_SCENARIOS=runner-unavailable pnpm -C app cuj:run`.
