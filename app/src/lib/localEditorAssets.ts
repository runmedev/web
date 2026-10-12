import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Configure before any editor mounts. Vite emits each worker and its imports;
// the React wrapper must never bootstrap Monaco through its default CDN loader.
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker()
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker()
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker()
    if (['typescript', 'javascript'].includes(label)) return new TsWorker()
    return new EditorWorker()
  },
}
loader.config({ monaco })
// The package does not expose this window extension in its public typings.
const excalidrawWindow: Window & { EXCALIDRAW_ASSET_PATH?: string } = window
excalidrawWindow.EXCALIDRAW_ASSET_PATH = '/assets/excalidraw/0.18.1/'
