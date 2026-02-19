# Runme Web (monorepo)

This project is structured as a pnpm workspace monorepo with the following packages:

- **@runme/console** [@runmedev/react-console](https://www.npmjs.com/package/@runmedev/react-console): A React component library containing the Runme Console component.

## Getting Started

Set up pnpm to use Buf registry:

```sh {"name":"configure","terminalRows":"5"}
pnpm config set @buf:registry https://buf.build/gen/npm/v1
```

Install all dependencies:

```sh {"name":"setup"}
pnpm install
```

## Building

Build all packages:

```sh {"name":"build"}
pnpm run build
```

Build a specific package:

```sh
pnpm run build:renderers
pnpm run build:console
```

Clean up:

```sh {"name":"clean"}
pnpm run clean
```

## Development

Start the development server for sample app using the components:

```sh {"name":"dev"}
pnpm run build:renderers
pnpm run build:console
pnpm run dev
```

## Testing

Will fail for a clean project. Be sure to build first.

```sh {"name":"test"}
pnpm run test:run
```

### Browser Smoke Tests

Run the browser smoke test for the app (frontend must already be running):

```sh
cd app && bash test/browser/test-smoke.sh
```

Run the backend-unavailable toast check (backend must be stopped, frontend running):

```sh
cd app && bash test/browser/test-backend-toast.sh
```

## Linting

Lint all packages:

```sh {"terminalRows":"37"}
pnpm run lint
```

## Structure

- `packages/renderers`: Foundational web component libraries
- `packages/react-console`: Runme Console is a terminal attached to a Runme execution.

All dependencies are managed efficiently through pnpm's workspace features.
