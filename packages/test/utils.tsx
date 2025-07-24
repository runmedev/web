import React, { ReactElement } from 'react'
import { BrowserRouter } from 'react-router-dom'

import { Theme } from '@radix-ui/themes'
import { RenderOptions, render } from '@testing-library/react'

// Custom render function that includes providers
interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  withRouter?: boolean
  withTheme?: boolean
}

const AllTheProviders = ({
  children,
  withRouter = true,
  withTheme = true,
}: {
  children: React.ReactNode
  withRouter?: boolean
  withTheme?: boolean
}) => {
  let content = children

  if (withTheme) {
    content = <Theme>{content}</Theme>
  }

  if (withRouter) {
    content = <BrowserRouter>{content}</BrowserRouter>
  }

  return <>{content}</>
}

const customRender = (ui: ReactElement, options: CustomRenderOptions = {}) => {
  const { withRouter = true, withTheme = true, ...renderOptions } = options

  return render(ui, {
    wrapper: ({ children }) => (
      <AllTheProviders withRouter={withRouter} withTheme={withTheme}>
        {children}
      </AllTheProviders>
    ),
    ...renderOptions,
  })
}

// Re-export everything
export * from '@testing-library/react'

// Override render method
export { customRender as render }
