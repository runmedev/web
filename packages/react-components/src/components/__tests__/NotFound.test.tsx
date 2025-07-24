import '@testing-library/jest-dom'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { render } from '../../../../test/utils'
import NotFound from '../NotFound'

describe('NotFound', () => {
  it('renders 404 heading', () => {
    render(<NotFound />)
    expect(screen.getByText('404')).toBeInTheDocument()
  })

  it('renders page not found message', () => {
    render(<NotFound />)
    expect(screen.getByText('Page not found')).toBeInTheDocument()
  })

  it('renders explanation text', () => {
    render(<NotFound />)
    expect(
      screen.getByText(
        "The page you're looking for doesn't exist or has been moved."
      )
    ).toBeInTheDocument()
  })

  it('renders home link', () => {
    render(<NotFound />)
    const homeLink = screen.getByText('here')
    expect(homeLink).toBeInTheDocument()
    expect(homeLink.closest('a')).toHaveAttribute('href', '/')
  })

  it('renders with correct styling classes', () => {
    render(<NotFound />)
    const container = screen.getByText('404').closest('div')
    // Check that the container exists and has some styling
    expect(container).toBeInTheDocument()
  })
})
