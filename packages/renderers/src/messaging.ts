import { Disposable } from 'vscode'
import { RendererContext } from 'vscode-notebook-renderer'

import { ClientMessage, ClientMessagePayload } from './types'

const DEFAULT_NAMESPACE = 'runme'
// Use a global symbol to ensure the contexts Map is shared across all module instances
// This is necessary because Vite/bundlers may create separate module instances
const GLOBAL_CONTEXTS_KEY = Symbol.for('@runmedev/renderers:contexts')

function getContextsMap(): Map<string, RendererContext<void>> {
  const globalObj = globalThis as any
  if (!globalObj[GLOBAL_CONTEXTS_KEY]) {
    globalObj[GLOBAL_CONTEXTS_KEY] = new Map<string, RendererContext<void>>()
  }
  return globalObj[GLOBAL_CONTEXTS_KEY]
}

const contexts = getContextsMap()

interface Messaging {
  postMessage(msg: unknown): Thenable<boolean> | Thenable<void> | void
  onDidReceiveMessage(cb: (message: any) => void): Disposable
}

export async function postClientMessage<T extends keyof ClientMessagePayload>(
  messaging: Partial<Messaging>,
  type: T,
  payload: ClientMessagePayload[T]
) {
  const msg = {
    type,
    output: payload,
  } as ClientMessage<T>

  return await messaging.postMessage?.(msg)
}

export function onClientMessage(
  messaging: Partial<Messaging>,
  cb: (message: ClientMessage<keyof ClientMessagePayload>) => void
): Disposable {
  return messaging.onDidReceiveMessage?.(cb) ?? { dispose: () => {} }
}

export function getContext(namespace?: string) {
  const ns = namespace ?? DEFAULT_NAMESPACE
  const context = contexts.get(ns)
  if (!context) {
    throw new Error(`Renderer context not defined for namespace: ${ns}`)
  }
  return context
}

export function setContext(c: RendererContext<void>, namespace?: string) {
  const ns = namespace ?? DEFAULT_NAMESPACE
  contexts.set(ns, c)
}

export function removeContext(namespace?: string) {
  const ns = namespace ?? DEFAULT_NAMESPACE
  contexts.delete(ns)
}
