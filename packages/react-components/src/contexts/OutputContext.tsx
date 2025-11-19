import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react'
import { JSX } from 'react'

import * as parser_pb from '@buf/runmedev_runme.bufbuild_es/runme/parser/v1/parser_pb'
import { create } from '@bufbuild/protobuf'

import CellConsole from '../components/Actions/CellConsole'
import { MimeType } from '../runme/client'

export interface OutputRenderer {
  onCellUpdate: (cell: parser_pb.Cell) => void
  component: (props: any) => JSX.Element
  props?: Record<string, any>
}

interface OutputContextType {
  registerRenderer: (mimeType: string, renderer: OutputRenderer) => void
  unregisterRenderer: (mimeType: string) => void
  getRenderer: (mimeType: string) => OutputRenderer | undefined
  getAllRenderers: () => Map<string, OutputRenderer>
}

const OutputContext = createContext<OutputContextType | undefined>(undefined)

// eslint-disable-next-line react-refresh/only-export-components
export const useOutput = () => {
  const context = useContext(OutputContext)
  if (!context) {
    throw new Error('useOutput must be used within an OutputProvider')
  }
  return context
}

interface OutputProviderProps {
  children: ReactNode
}

export const OutputProvider = ({ children }: OutputProviderProps) => {
  const renderers = useMemo(() => new Map<string, OutputRenderer>(), [])

  const registerRenderer = useCallback(
    (mimeType: string, renderer: OutputRenderer) => {
      renderers.set(mimeType, renderer)
    },
    [renderers]
  )

  const unregisterRenderer = useCallback(
    (mimeType: string) => {
      renderers.delete(mimeType)
    },
    [renderers]
  )

  const getRenderer = useCallback(
    (mimeType: string) => {
      return renderers.get(mimeType)
    },
    [renderers]
  )

  const getAllRenderers = useCallback(() => {
    return renderers
  }, [renderers])

  const contextValue = useMemo(
    () => ({
      registerRenderer,
      unregisterRenderer,
      getRenderer,
      getAllRenderers,
    }),
    [registerRenderer, unregisterRenderer, getRenderer, getAllRenderers]
  )

  // Register renderers for code cells
  useEffect(() => {
    registerRenderer(MimeType.StatefulRunmeTerminal, {
      onCellUpdate: (cell: parser_pb.Cell) => {
        if (cell.kind !== parser_pb.CellKind.CODE || cell.outputs.length > 0) {
          return
        }

        // it's basically shell, be prepared to render a terminal
        cell.outputs = [
          create(parser_pb.CellOutputSchema, {
            items: [
              create(parser_pb.CellOutputItemSchema, {
                mime: MimeType.StatefulRunmeTerminal,
                type: 'Buffer',
                data: new Uint8Array(), // todo(sebastian): pass terminal settings
              }),
            ],
          }),
        ]
      },
      component: ({
        cell,
        onPid,
        onExitCode,
      }: {
        cell: parser_pb.Cell
        onPid: (pid: number | null) => void
        onExitCode: (exitCode: number | null) => void
      }) => {
        return (
          <CellConsole
            key={`console-${cell.refId}`}
            cell={cell}
            onPid={onPid}
            onExitCode={onExitCode}
          />
        )
      },
    })

    return () => {
      unregisterRenderer(MimeType.StatefulRunmeTerminal)
    }
  }, [registerRenderer, unregisterRenderer])

  return (
    <OutputContext.Provider value={contextValue}>
      {children}
    </OutputContext.Provider>
  )
}
