import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { GoogleDriveResourcePickerDialog } from '../../src/components/Workspace/GoogleDriveResourcePickerDialog'
import { setGoogleDriveBaseUrl } from '../../src/lib/googleDriveRuntime'
import '../../src/index.css'

setGoogleDriveBaseUrl('http://127.0.0.1:9098')

/** Exercises the production picker and resolver against the Go Drive fixture. */
export function DrivePathsFixture() {
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState('')
  return (
    <main className="p-8">
      <h1>Drive search paths — synthetic test data</h1>
      <button onClick={() => setOpen(true)}>Open folder picker</button>
      <p id="selected-resource">{selected}</p>
      {open && (
        <GoogleDriveResourcePickerDialog
          accessToken="synthetic-test-token"
          mode="folder"
          onCancel={() => setOpen(false)}
          onSelect={(resource) => {
            setSelected(`Selected ID: ${resource.id}`)
            setOpen(false)
          }}
        />
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<DrivePathsFixture />)
