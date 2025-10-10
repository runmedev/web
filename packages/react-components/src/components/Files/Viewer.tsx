import { useEffect, useMemo, useRef } from 'react'

import { DocResult } from '@buf/runmedev_runme.bufbuild_es/runme/parser/v1/docresult_pb'
import { create } from '@bufbuild/protobuf'
import { Box, Link, ScrollArea, Text } from '@radix-ui/themes'

import { parser_pb, useCell } from '../../contexts/CellContext'

const FileViewer = () => {
  // The code below is using "destructuring" assignment to assign certain values from the
  // context object return by useCell to local variables.
  const { useColumns } = useCell()
  const { files } = useColumns()

  // automatically scroll to bottom of files
  const filesEndRef = useRef<HTMLDivElement | null>(null)
  const scrollToBottom = () => {
    filesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const oneCell = useMemo(() => {
    let cell: parser_pb.Cell = create(parser_pb.CellSchema, {})

    // N.B. Right now we don't support more than one search cell
    if (files.length > 0) {
      cell = files[files.length - 1]
    }

    return cell
  }, [files])

  // TODO(jlewi): Why do we pass in chatCells as a dependency?
  // sebastian: because otherwise it won't rerender when the cell changes
  useEffect(() => {
    scrollToBottom()
  }, [oneCell])

  const hasSearchResults = oneCell.docResults.length > 0

  return (
    <div className="flex flex-col h-full">
      <Text size="5" weight="bold" className="mb-2">
        Docs
      </Text>
      <ScrollArea type="auto" scrollbars="vertical" className="flex-1 pt-4">
        {!hasSearchResults ? (
          <div>
            <div>No search results yet</div>
            <div ref={filesEndRef} className="h-1" />
          </div>
        ) : (
          <div className="grow">
            {oneCell.docResults.map((b: DocResult) => (
              <div key={b.fileId} className="mb-2">
                <Box
                  p="2"
                  style={{
                    borderRadius: '6px',
                    border: '1px solid var(--gray-5)',
                  }}
                >
                  <Text size="2" weight="medium">
                    <Link
                      href={b.link}
                      target="_blank"
                      className="text-blue-500 hover:underline"
                    >
                      {b.fileName}
                    </Link>
                  </Text>
                </Box>
              </div>
            ))}
            <div ref={filesEndRef} className="h-1" />
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

export default FileViewer
