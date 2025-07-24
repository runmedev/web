import { memo } from 'react'

import { Console } from '@runmedev/react-console'

import { useSettings } from '../../contexts/SettingsContext'
import { getSessionToken } from '../../token'

// todo(sebastian): we should turn this into a CellConsole and mold this component to the Cell type
const CellConsole = memo(
  ({
    cellID,
    runID,
    sequence,
    value,
    content,
    settings = {},
    onStdout,
    onStderr,
    onExitCode,
    onPid,
    onMimeType,
  }: {
    cellID: string
    runID: string
    sequence: number
    value: string
    content?: string
    settings?: {
      className?: string
      rows?: number
      fontSize?: number
      fontFamily?: string
      takeFocus?: boolean
      scrollToFit?: boolean
    }
    onStdout: (data: Uint8Array) => void
    onStderr: (data: Uint8Array) => void
    onExitCode: (code: number) => void
    onPid: (pid: number) => void
    onMimeType: (mimeType: string) => void
  }) => {
    const { webApp } = useSettings().settings
    return (
      ((value != '' && runID != '') || (content && content.length > 0)) && (
        <Console
          cellID={cellID}
          runID={runID}
          sequence={sequence}
          commands={value.split('\n')}
          content={content}
          runner={{
            endpoint: webApp.runner,
            reconnect: webApp.reconnect,
            authorization: {
              bearerToken: getSessionToken(),
            },
          }}
          settings={settings}
          onPid={onPid}
          onStdout={onStdout}
          onStderr={onStderr}
          onExitCode={onExitCode}
          onMimeType={onMimeType}
        />
      )
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.cellID === nextProps.cellID &&
      JSON.stringify(prevProps.value) === JSON.stringify(nextProps.value) &&
      prevProps.runID === nextProps.runID
    )
  }
)

export default CellConsole
