import { contextBridge, ipcRenderer } from 'electron'

import { type DesktopBridge, channels } from './protocol.js'

// Sandboxed preload exposes only the tool transport, never ipcRenderer or Node.
const bridge: DesktopBridge = {
  googleAccessToken: (request) =>
    ipcRenderer.invoke(channels.googleToken, request),
  publishTools: (tools) => ipcRenderer.send(channels.catalog, tools),
  onRequest: (listener) => {
    const handler = (
      _event: unknown,
      request: Parameters<typeof listener>[0]
    ) => listener(request)
    ipcRenderer.on(channels.request, handler)
    return () => ipcRenderer.removeListener(channels.request, handler)
  },
  respond: (response) => ipcRenderer.send(channels.response, response),
}
if (process.isMainFrame) contextBridge.exposeInMainWorld('runmeDesktop', bridge)
