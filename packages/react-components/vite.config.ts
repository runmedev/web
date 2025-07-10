import { resolve } from 'path'

import { createSharedConfig } from '../vite.common'

export default createSharedConfig({
  entry: resolve(__dirname, 'src/index.tsx'),
  name: 'RunmeComponents',
  fileName: (format) =>
    format === 'es' ? 'react-components.mjs' : 'react-components.cjs',
})
