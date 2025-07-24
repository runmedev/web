# Runme Web (monorepo)

This project is structured as an npm monorepo with two packages:

- **@runme/console** [@runmedev/react-console](https://www.npmjs.com/package/@runmedev/react-console): A React component library containing the Runme Console component.
- **@runme/components** [@runmedev/react-components](https://www.npmjs.com/package/@runmedev/react-components): A React component library containing the Runme components plus a example app.

## Getting Started

Set up NPM to use Buf registry:

```sh {"name":"configure","terminalRows":"5"}
npm config set @buf:registry https://buf.build/gen/npm/v1
```

Install all dependencies (hoisted to the root):

```sh {"name":"setup"}
npm install
```

## Building

Build all packages:

```sh {"name":"build"}
npm run build
```

Build a specific package:

```sh
npm run build:console
npm run build:components
```

Clean up:

```sh {"name":"clean"}
npm run clean
```

## Development

Start the development server for sample app using the components:

```sh {"name":"dev"}
npm run build:console
npm run dev
```

## Testing

```sh {"name":"test"}
npm run test:run
```

## Linting

Lint all packages:

```sh {"terminalRows":"37"}
npm run lint
```

Lint a specific package:

```sh
npm run lint -w packages/react
npm run lint -w packages/components
```

## Structure

- `packages/react-components`: React component library (Runme)
- `packages/react-console`: Runme Console is a terminal attached to a Runme execution.

All dependencies are hoisted to the root for efficient management.
