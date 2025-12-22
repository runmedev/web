import { Observable, Subject } from 'rxjs'
import { VSCodeEvent } from 'vscode-notebook-renderer/events'

import { type StreamsLike } from '../streams'
import {
  ExecuteRequest,  
} from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'

export class FakeStreams implements StreamsLike {
  stdout = new Subject<Uint8Array>()
  stderr = new Subject<Uint8Array>()
  exitCode = new Subject<number>()
  pid = new Subject<number>()
  mimeType = new Subject<string>()

  //#callback?: VSCodeEvent<any>

  connect(): Observable<unknown> {
    // Immediately emit a fake pid and mimeType if desired
    return new Observable((observer) => {
      observer.next(undefined)
      observer.complete()
    })
  }

  sendExecuteRequest(executeRequest: ExecuteRequest): void {
    console.log('FakeStreams: sendExecuteRequest called new version', executeRequest)
    const input = executeRequest.inputData
    if (input && input.length) {
      console.log('FakeStreams: Sending input to stdout.')
      this.stdout.next(input)
    } else {
      console.log('FakeStreams: No input data provided.')
      this.stdout.next(new TextEncoder().encode('FakeStreams: No input data provided.\r\n'))
    }
  }

  setCallback(_: VSCodeEvent<any>): void {
    //this.#callback = callback
  }

  close(): void {
    this.stdout.complete()
    this.stderr.complete()
    this.exitCode.complete()
    this.pid.complete()
    this.mimeType.complete()
  }
}
