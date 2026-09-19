import type LocalNotebooks from '../storage/local'
import type { ComparisonSelection } from './operationLog/comparisons'
import {
  getGraderSettings,
  gradeSuggestion,
  saveGraderSettings,
} from './suggestionGrader'
import { prepareSuggestionInput } from './suggestionGraderInput'

/** Shared UI/agent path; a concrete notebook and frozen comparison are mandatory. */
export function createSuggestionGraderApi(deps: {
  localStore: () => LocalNotebooks | null
  signal?: AbortSignal
}) {
  return {
    getSettings: getGraderSettings,
    setSettings: saveGraderSettings,
    async grade(args: {
      target: { uri: string }
      comparison: ComparisonSelection
      cellId: string
    }) {
      if (
        !args?.target?.uri?.startsWith('local://file/') ||
        !args.cellId ||
        !args.comparison
      )
        throw new Error('Expected target.uri, comparison and cellId')
      const store = deps.localStore()
      if (!store) throw new Error('Local notebook store unavailable')
      const preview = await store.previewNotebookComparison(
        args.target.uri,
        args.comparison
      )
      return gradeSuggestion(
        prepareSuggestionInput(preview, args.cellId),
        deps.signal
      )
    },
    help: () =>
      [
        'suggestionGrader.getSettings() // no secrets returned',
        'suggestionGrader.setSettings({enabled, model, organization, project, apiKey?}) // local only; prefer entering secrets in UI',
        'await suggestionGrader.grade({target:{uri}, comparison:{startRevisionId,endRevisionId}, cellId}) // sends content to OpenAI; advisory only',
        'Uses the same content-only prompt as trainingExamples.encodeSftExample; never records a decision.',
      ].join('\n'),
  }
}
