# Shared Testing Infrastructure

This directory contains the shared testing infrastructure for all packages in the monorepo using Vitest.

## Setup

The testing setup includes:

- **Vitest**: Fast unit test runner
- **jsdom**: DOM environment for testing React components
- **@testing-library/react**: React testing utilities
- **@testing-library/jest-dom**: Custom matchers for DOM testing
- **@testing-library/user-event**: User interaction simulation

## File Structure

```
packages/
├── test/
│   ├── setup.ts          # Global test setup and mocks
│   ├── utils.tsx         # Custom render function and test utilities
│   └── README.md         # This file
├── vitest.config.ts      # Shared Vitest configuration
├── react-console/        # Package with tests
└── ...                   # Other packages
```

## Usage in Packages

### 1. Install Dependencies

Each package should include these dev dependencies:

```json
{
  "devDependencies": {
    "vitest": "^2.0.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/user-event": "^14.0.0",
    "@vitest/ui": "^2.0.0",
    "@vitejs/plugin-react": "^4.0.0"
  }
}
```

### 2. Add Test Scripts

Add these scripts to each package's `package.json`:

```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage"
  }
}
```

### 3. Create Package-Specific Config

Each package should have a `vitest.config.ts` that extends the shared config:

```typescript
import { resolve } from 'path'
import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from '../vitest.config'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      setupFiles: ['../test/setup.ts'],
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
  })
)
```

### 4. Import Test Utilities

In your test files, import from the shared test utilities:

```typescript
import { render, screen, fireEvent } from '../test/utils'
// or
import { render, screen, fireEvent } from '../../test/utils'
```

## Test Conventions

### File Naming

- Test files should be named `*.test.ts` or `*.test.tsx`
- Place test files in `__tests__` directories next to the source files
- For utility functions, place tests in `src/__tests__/`

### Test Structure

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../test/utils'
import Component from '../Component'

describe('Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders correctly', () => {
    render(<Component />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('handles user interactions', () => {
    render(<Component />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Clicked')).toBeInTheDocument()
  })
})
```

### Custom Render Function

Use the custom render function from `test/utils.tsx` for components that need providers:

```typescript
import { render } from '../test/utils'

// With default providers (Router + Theme)
render(<Component />)

// Without specific providers
render(<Component />, { withRouter: false, withTheme: false })
```

### Mocking

- Mock external dependencies using `vi.mock()`
- Mock browser APIs in `test/setup.ts`
- Use `vi.spyOn()` for spying on functions
- Clear mocks in `beforeEach` hooks

### Testing Patterns

1. **Component Tests**: Test rendering, user interactions, and props
2. **Context Tests**: Test provider behavior and hook usage
3. **Utility Tests**: Test pure functions with various inputs
4. **Integration Tests**: Test component interactions

### Best Practices

- Test behavior, not implementation
- Use semantic queries (getByRole, getByLabelText)
- Avoid testing implementation details
- Write descriptive test names
- Group related tests with `describe` blocks
- Use `data-testid` sparingly, prefer semantic queries
