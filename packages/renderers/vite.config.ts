import { resolve } from 'path'

import { createSharedConfig } from '../vite.common'

export default createSharedConfig({
  entry: resolve(__dirname, 'src/index.ts'),
  name: 'RunmeRenderers',
  fileName: (format, entryName) => {
    return format === 'es' ? `${entryName}.mjs` : `${entryName}.cjs`
  }
})
