import { Disposable } from 'vscode'

import { ClientMessage, ClientMessagePayload } from './types'

interface Messaging {
  postMessage(msg: unknown): Thenable<boolean> | Thenable<void> | void
  onDidReceiveMessage(cb: (message: any) => void): Disposable
}

export async function postClientMessage<T extends keyof ClientMessagePayload>(
  messaging: Partial<Messaging>,
  type: T,
  payload: ClientMessagePayload[T],
) {
  const msg = {
    type,
    output: payload,
  } as ClientMessage<T>

  return await messaging.postMessage?.(msg)
}

export function onClientMessage(
  messaging: Partial<Messaging>,
  cb: (message: ClientMessage<keyof ClientMessagePayload>) => void,
): Disposable {
  return messaging.onDidReceiveMessage?.(cb) ?? { dispose: () => {} }
}
