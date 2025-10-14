import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
global.localStorage = localStorageMock

// Mock sessionStorage
const sessionStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
global.sessionStorage = sessionStorageMock

// Mock HTMLCanvasElement.getContext for xterm.js
HTMLCanvasElement.prototype.getContext = vi.fn(() => {
  return {
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(),
    putImageData: vi.fn(),
    createImageData: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    fillText: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    transform: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
  }
}) as any

// Mock CSSStyleSheet for web components
class CSSStyleSheetMock {
  replaceSync = vi.fn()
  replace = vi.fn(() => Promise.resolve(this))
  insertRule = vi.fn()
  deleteRule = vi.fn()
  cssRules = []
}

// @ts-ignore
global.CSSStyleSheet = CSSStyleSheetMock

// Mock document.adoptedStyleSheets
try {
  Object.defineProperty(document, 'adoptedStyleSheets', {
    writable: true,
    configurable: true,
    value: [],
  })
} catch {
  // Already defined, skip
}

// Mock ShadowRoot.adoptedStyleSheets
if (typeof ShadowRoot !== 'undefined') {
  try {
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      get() {
        return this._adoptedStyleSheets || []
      },
      set(value) {
        this._adoptedStyleSheets = value
      },
    })
  } catch {
    // Already defined, skip
  }
}
