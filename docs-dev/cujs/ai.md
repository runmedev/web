# AI Assistant Interaction

This CUJ validates that a user can interact with the assistant through the ChatKit
panel.

## Preconditions

- Frontend is running (default: `http://localhost:5173`).
- `agent-browser` is available on `PATH`.
- Optional: CUJ auth token env vars (`CUJ_ID_TOKEN`, `CUJ_ACCESS_TOKEN`).

## Steps

1. Open the app and open the ChatKit panel.
2. Use App Console to configure and set the default assistant harness.
3. Type and submit a user message in the ChatKit panel.
4. Verify the assistant response appears in the ChatKit panel.

## Acceptance Criteria

- [ ] User can open the ChatKit panel.
- [ ] User can configure harness routing from App Console.
- [ ] User can type and send a message in the ChatKit panel.
- [ ] User sees the assistant response in the ChatKit panel.
