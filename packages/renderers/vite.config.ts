import { resolve } from 'path'

import { createSharedConfig } from '../vite.common'

export default createSharedConfig({
  entry: resolve(__dirname, 'src/index.ts'),
  name: 'RunmeRenderers',
  fileName: (format) =>
    format === 'es' ? 'runme-renderers.mjs' : 'runme-renderers.cjs',
})
