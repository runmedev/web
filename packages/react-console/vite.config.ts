import { resolve } from 'path'

import { createSharedConfig } from '../vite.common'

export default createSharedConfig({
  entry: resolve(__dirname, 'src/index.tsx'),
  name: 'RunmeConsole',
  fileName: (format) =>
    format === 'es' ? 'react-console.mjs' : 'react-console.cjs',
})
