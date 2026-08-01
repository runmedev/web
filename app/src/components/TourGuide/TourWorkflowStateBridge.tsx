import { useEffect } from 'react'

import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import { useSidePanel } from '../../contexts/SidePanelContext'
import { publishTourState } from '../../lib/tourWorkflow'

/** Publishes React-owned UI state to the semantic tour workflow registry. */
export default function TourWorkflowStateBridge() {
  const { isDriveSyncing } = useGoogleAuth()
  const { activePanel } = useSidePanel()

  useEffect(() => {
    publishTourState('google-drive.authorized', isDriveSyncing)
  }, [isDriveSyncing])

  useEffect(() => {
    publishTourState('side-panel.active', activePanel)
  }, [activePanel])

  return null
}
