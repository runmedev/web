import { useEffect } from 'react'

import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import { tourUiController } from '../../lib/tourUiController'

/** Publishes non-sensitive auth state that is still owned by React. */
export default function TourUiStateBridge() {
  const { isDriveSyncing } = useGoogleAuth()

  useEffect(() => {
    tourUiController.setGoogleDriveAuthorized(isDriveSyncing)
  }, [isDriveSyncing])

  return null
}
