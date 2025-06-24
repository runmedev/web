# Runme Web Monorepo

This project is now structured as an npm monorepo with two packages:

- **@runme/console**: A React component library containing the Runme components (in `packages/console`).
- **@runme/components**: The main application and supporting code (in `packages/components`).

## Getting Started

Install all dependencies (hoisted to the root):

```sh
npm install
```

## Building

Build all packages:

```sh
npm run build
```

Build a specific package:

```sh
npm run build -w packages/react
npm run build -w packages/components
```

## Development

Start the development server for the components app:

```sh
npm run dev -w packages/components
```

## Linting

Lint all packages:

```sh
npm run lint
```

Lint a specific package:

```sh
npm run lint -w packages/react
npm run lint -w packages/components
```

## Structure

- `packages/react`: React component library (Runme)
- `packages/components`: Main application and supporting code

All dependencies are hoisted to the root for efficient management.
