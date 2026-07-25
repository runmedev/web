import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: '.vite',
  define: {
    'import.meta.env.VITE_RUNME_VERSION_WEB_REPO': JSON.stringify(
      process.env.VITE_RUNME_VERSION_WEB_REPO || 'runmedev/web'
    ),
    'import.meta.env.VITE_RUNME_VERSION_WEB_COMMIT': JSON.stringify(
      process.env.VITE_RUNME_VERSION_WEB_COMMIT || 'test-web-commit'
    ),
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.d.ts',
        '**/*.config.*',
        'dist/',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
})
