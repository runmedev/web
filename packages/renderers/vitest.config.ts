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
