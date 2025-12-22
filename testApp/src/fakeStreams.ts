type Listener<T> = (value: T) => void

export type FakeStreamsProps = {
  knownID: string
}

export class FakeStreams {
  stdoutListeners: Listener<Uint8Array>[] = []
  stderrListeners: Listener<Uint8Array>[] = []
  exitListeners: Listener<number>[] = []
  pidListeners: Listener<number>[] = []
  mimeListeners: Listener<string>[] = []

  connect() {
    return {
      subscribe: () => ({ unsubscribe() {} }),
    }
  }

  sendExecuteRequest(req: any) {
    if (req?.inputData) {
      const data = req.inputData instanceof Uint8Array ? req.inputData : new Uint8Array()
      this.stdoutListeners.forEach((fn) => fn(data))
    }
  }

  setCallback(_cb: any) {
    // no-op for fake
  }

  close() {
    // no-op
  }

  get stdout() {
    return {
      subscribe: (fn: Listener<Uint8Array>) => {
        this.stdoutListeners.push(fn)
        return { unsubscribe: () => {} }
      },
    }
  }

  get stderr() {
    return {
      subscribe: (fn: Listener<Uint8Array>) => {
        this.stderrListeners.push(fn)
        return { unsubscribe: () => {} }
      },
    }
  }

  get exitCode() {
    return {
      subscribe: (fn: Listener<number>) => {
        this.exitListeners.push(fn)
        return { unsubscribe: () => {} }
      },
    }
  }

  get pid() {
    return {
      subscribe: (fn: Listener<number>) => {
        this.pidListeners.push(fn)
        return { unsubscribe: () => {} }
      },
    }
  }

  get mimeType() {
    return {
      subscribe: (fn: Listener<string>) => {
        this.mimeListeners.push(fn)
        return { unsubscribe: () => {} }
      },
    }
  }
}
