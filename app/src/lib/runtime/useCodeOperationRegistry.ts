import { useMemo, useRef } from 'react'

import type { CodeModeExecutor } from './codeModeExecutor'
import {
  type CodeOperationRegistry,
  createCodeOperationRegistry,
} from './codeOperationRegistry'

export function useCodeOperationRegistry(
  executor: CodeModeExecutor
): CodeOperationRegistry {
  const executorRef = useRef(executor)
  executorRef.current = executor
  return useMemo(
    () =>
      createCodeOperationRegistry({
        executor: {
          execute: (args) => executorRef.current.execute(args),
        },
      }),
    []
  )
}
