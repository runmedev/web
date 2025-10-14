# Runme Web (monorepo)

This project is structured as a pnpm workspace monorepo with two packages:

- **@runme/console** [@runmedev/react-console](https://www.npmjs.com/package/@runmedev/react-console): A React component library containing the Runme Console component.
- **@runme/components** [@runmedev/react-components](https://www.npmjs.com/package/@runmedev/react-components): A React component library containing the Runme components plus a example app.

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
pnpm run build:components
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

## Linting

Lint all packages:

```sh {"terminalRows":"37"}
pnpm run lint
```

## Structure

- `packages/renderers`: Foundational web component libraries
- `packages/react-components`: React component library (Runme) & example app
- `packages/react-console`: Runme Console is a terminal attached to a Runme execution.

All dependencies are managed efficiently through pnpm's workspace features.
