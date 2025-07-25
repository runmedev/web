import { resolve } from 'path'
import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from '../vitest.config'

export default defineConfig(async () => {
  const base = await baseConfig
  return mergeConfig(base, {
    test: {
      setupFiles: ['../test/setup.ts'],
      globals: true,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
  })
})
