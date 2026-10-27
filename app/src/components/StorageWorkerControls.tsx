import { useEffect, useRef, useState } from 'react'
import { storageRecovery } from '../storage/storageRecovery'
import {
  StorageWorkerControl,
  type WorkerStatus,
} from '../storage/storageWorkerControl'

/** Recovery stays independent of the release-settings and notebook databases. */
export function StorageWorkerControls() {
  const [workers, setWorkers] = useState<Map<string, WorkerStatus>>(new Map())
  const management = useRef<StorageWorkerControl | undefined>(undefined)
  useEffect(() => {
    const control = new StorageWorkerControl((event) => {
      setWorkers((previous) =>
        new Map(previous).set(event.status.instanceId, event.status)
      )
    })
    management.current = control
    control.discover()
    return () => {
      management.current = undefined
      control.close()
    }
  }, [])
  return (
    <section id="storage-worker-controls" className="my-3 rounded border p-3">
      <h3 className="font-semibold">Storage workers</h3>
      <p>
        These are responding Runme workers for this site, not all browser
        workers. Refresh to request current status. No reply means unknown
        status.
      </p>
      <button
        type="button"
        className="mr-3 underline"
        onClick={() => {
          setWorkers(new Map())
          management.current?.discover()
        }}
      >
        Refresh workers
      </button>
      <button
        type="button"
        className="mr-3 underline"
        onClick={() => storageRecovery.restart()}
      >
        Restart current storage
      </button>
      <button
        type="button"
        className="underline"
        onClick={() => storageRecovery.restart(true)}
      >
        Force restart current storage
      </button>
      <p>
        Restart keeps editors open. Force restart skips waiting for pending
        work; retained editor saves retry after reconnecting. Other operations
        may have an uncertain outcome.
      </p>
      {[...workers.values()].map((worker) => (
        <div
          key={worker.instanceId}
          id={`storage-worker-${worker.instanceId}`}
          className="mt-3 border-t pt-2"
        >
          <p>
            {worker.releaseId ?? 'Development worker'} · epoch {worker.epoch} ·{' '}
            {worker.phase} ({Math.round(worker.phaseElapsedMs / 1000)}s at last
            reply)
          </p>
          <p className="break-all text-xs">Instance: {worker.instanceId}</p>
          <button
            type="button"
            disabled={worker.phase === 'closing'}
            className="mr-3 underline disabled:opacity-50"
            onClick={() =>
              management.current?.stop(worker.instanceId, {
                force: false,
                restart: false,
              })
            }
          >
            Stop worker
          </button>
          <button
            type="button"
            disabled={worker.phase === 'closing'}
            className="underline disabled:opacity-50"
            onClick={() =>
              management.current?.stop(worker.instanceId, {
                force: true,
                restart: false,
              })
            }
          >
            Force stop worker
          </button>
          <details>
            <summary>Worker diagnostics</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(worker, null, 2)}
            </pre>
          </details>
        </div>
      ))}
      <p className="mt-2">
        A force request still needs a responsive worker message loop. For a
        completely unresponsive worker, use the browser’s worker inspection
        tools (Chrome: chrome://inspect/#workers). Keep tabs open to retain
        unsaved edits; download recovery copies before closing them. Do not
        clear site data.
      </p>
    </section>
  )
}
