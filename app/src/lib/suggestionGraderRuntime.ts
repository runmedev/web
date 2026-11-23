import type LocalNotebooks from '../storage/local'
import type { ComparisonSelection } from './operationLog/comparisons'
import {
  getGraderSettings,
  gradeExample,
  gradePhrase,
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
    gradeExample: (input: Parameters<typeof gradeExample>[0]) =>
      gradeExample(input, deps.signal),
    gradePhrase: (input: Parameters<typeof gradePhrase>[0]) =>
      gradePhrase(input, deps.signal),
    getSettings: getGraderSettings,
    // A sandbox caller may update preferences but cannot authorize a different vault secret.
    setSettings(input: Parameters<typeof saveGraderSettings>[0]) {
      const selected = getGraderSettings().keyName
      if (input.keyName !== undefined && input.keyName !== selected)
        throw new Error('Select the key in AI grader settings.')
      return saveGraderSettings({ ...input, keyName: selected })
    },
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
        'suggestionGrader.setSettings({enabled, instructionsUri, organization, project}) // select the Key Vault entry in AI grader settings',
        'await suggestionGrader.grade({target:{uri}, comparison:{startRevisionId,endRevisionId}, cellId}) // sends content to OpenAI; advisory only',
        'await suggestionGrader.gradeExample({base, diff, rubric: {version, instructions}}) // frozen records and rubric; returns acceptProbability, accepted, model, requestId, rubricVersion',
        'await suggestionGrader.gradePhrase({text, context?}) // advisory Decisions classification',
      ].join('\n'),
  }
}
