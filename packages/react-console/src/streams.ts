/* eslint-disable @typescript-eslint/no-explicit-any */
import { Code } from '@buf/googleapis_googleapis.bufbuild_es/google/rpc/code_pb'
import {
  ExecuteRequest,
  ExecuteResponse,
} from '@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb'
import * as pb from '@buf/stateful_runme.bufbuild_es/runme/stream/v1/websockets_pb'
import { fromJson, toJson } from '@bufbuild/protobuf'
import { create } from '@bufbuild/protobuf'
import {
  Interceptor,
  StreamRequest,
  StreamResponse,
  UnaryRequest,
  UnaryResponse,
} from '@connectrpc/connect'
import {
  Observable,
  Subject,
  Subscription,
  asyncScheduler,
  bufferWhen,
  catchError,
  connectable,
  filter,
  finalize,
  fromEvent,
  interval,
  map,
  merge,
  mergeMap,
  of,
  race,
  scan,
  share,
  skipUntil,
  switchMap,
  take,
  takeWhile,
  tap,
  throttleTime,
  timer,
  withLatestFrom,
} from 'rxjs'
import { ulid } from 'ulid'
import { v4 as uuidv4 } from 'uuid'
import { VSCodeEvent } from 'vscode-notebook-renderer/events'

// @ts-expect-error because the webcomponents are not typed
import { ClientMessages } from './renderers/client'

const HEARTBEAT_INTERVAL_MS = 5_000
const MONITOR_INTERVAL_MS = 1_000
const MAX_LATENCY_DEADLINE_MS = 4_000
const RECONNECT_THROTTLE_MS = 1_000

export type StreamError = Error | pb.WebsocketStatus

// Interceptor types are imported from @connectrpc/connect

export type NextFunc = (
  request: UnaryRequest | StreamRequest
) => Promise<UnaryResponse | StreamResponse>

export enum Heartbeat {
  CONTINUOUS = 'CONTINUOUS',
  INITIAL = 'INITIAL',
}

export type Authorization = {
  bearerToken: string | undefined
}

type ReconnectConfig = {
  streamID: string
  heartbeat: Heartbeat
}

type Latency = {
  streamID: string
  latency: number
  readyState: number
  updatedAt: bigint
}

type StreamsProps = {
  knownID: string
  runID: string
  sequence: number
  options: {
    runnerEndpoint: string
    interceptors: Interceptor[]
    autoReconnect: boolean
  }
}

class Streams {
  private callback: VSCodeEvent<any> | undefined

  private readonly queue = new Subject<pb.WebsocketRequest>()

  private subscriptions: Subscription[] = []

  // Transport related
  private reconnect = new Subject<ReconnectConfig>()
  private client = new Observable<WebSocket>()

  // Track transport latencies for each stream.
  private _latencies = new Subject<Latency>()
  private _latenciesConnectable = connectable(
    this._latencies.asObservable().pipe(
      scan((acc, curr) => {
        // negative latencies signal that the stream was closed
        if (curr.latency < 0) {
          const l = acc.get(curr.streamID)
          if (l) {
            acc.set(curr.streamID, {
              ...l,
              readyState: curr.readyState,
            })
          }
        } else {
          acc.set(curr.streamID, curr)
        }
        return acc
      }, new Map<string, Latency>())
    )
  )

  // Returns an observable that emits the latencies for all streams.
  public get latencies() {
    return this._latenciesConnectable
  }

  // App protocol-level errors
  private _errors = new Subject<StreamError>()
  private _errorsConnectable = connectable(this._errors.asObservable())

  public get errors() {
    return this._errorsConnectable
  }

  // App protocol-level data streams
  private _stdout = new Subject<Uint8Array>()
  private _stderr = new Subject<Uint8Array>()
  private _exitCode = new Subject<number>()
  private _pid = new Subject<number>()
  private _mimeType = new Subject<string>()

  // Make data streams multicast so that we can subscribe to them multiple times
  private _stdoutConnectable = connectable(this._stdout.asObservable())
  private _stderrConnectable = connectable(this._stderr.asObservable())
  private _exitCodeConnectable = connectable(this._exitCode.asObservable())
  private _pidConnectable = connectable(this._pid.asObservable())
  private _mimeTypeConnectable = connectable(this._mimeType.asObservable())

  public get stdout() {
    return this._stdoutConnectable
  }
  public get stderr() {
    return this._stderrConnectable
  }
  public get exitCode() {
    return this._exitCodeConnectable
  }
  public get pid() {
    return this._pidConnectable
  }
  public get mimeType() {
    return this._mimeTypeConnectable
  }

  // Identifiers for the cell/console associated with this stream
  private readonly knownID: string
  private readonly runID: string
  private readonly sequence: number

  // Configuration
  private readonly runnerEndpoint: string
  private readonly interceptors: Interceptor[]
  private readonly autoReconnect: boolean

  constructor({ knownID, runID, sequence, options }: StreamsProps) {
    // Set the identifiers
    this.knownID = knownID
    this.runID = runID
    this.sequence = sequence

    // Assign configuration
    this.runnerEndpoint = options.runnerEndpoint
    this.interceptors = options.interceptors
    this.autoReconnect = options.autoReconnect

    // Turn the connectables into hot observables
    this._latenciesConnectable.connect()
    this._errorsConnectable.connect()
    this._stdoutConnectable.connect()
    this._stderrConnectable.connect()
    this._exitCodeConnectable.connect()
    this._pidConnectable.connect()
    this._mimeTypeConnectable.connect()

    // Create a new socket client for each reconnect
    this.client = this.reconnect
      .pipe(
        // Smartly throttle the reconnects to avoid overwhelming the server
        throttleTime(RECONNECT_THROTTLE_MS, asyncScheduler, {
          leading: true,
          trailing: true,
        }),
        // switchMap avoids overlapping socket clients; mergeMap would allow overlapping
        switchMap((config) => {
          // construct a new socket client for each reconnect
          return this.useSocketClient(config.streamID).pipe(
            switchMap((socket) => {
              // add a heartbeat to the socket
              return this.useHeartbeat(socket, config)
            })
          )
        })
      )
      .pipe(share())

    this.subscriptions.push(this.monitor())
    this.subscriptions.push(this.process())
  }

  private monitor(): Subscription {
    // Monitor the latencies and trigger reconnects if the latency is too high
    const monitor = interval(MONITOR_INTERVAL_MS).pipe(
      filter(() => this.autoReconnect),
      withLatestFrom(this.reconnect),
      filter(([, reconnect]) => reconnect.heartbeat === Heartbeat.CONTINUOUS),
      withLatestFrom(this.latencies),
      map(([, latencies]) =>
        Array.from(latencies.values()).filter(
          (latency) =>
            latency.readyState === WebSocket.OPEN &&
            latency.latency >= MAX_LATENCY_DEADLINE_MS
        )
      ),
      filter((latencies) => latencies.length > 0),
      // tap((latencies) => console.log('Monitor latencies', latencies)),
      // Throttle the reconnects to avoid overwhelming the server
      throttleTime(RECONNECT_THROTTLE_MS)
    )

    // Monitor the latencies and trigger reconnects if the latency is too high
    return monitor.subscribe({
      next: (latencies) => {
        console.log(new Date(), 'Triggering reconnect', latencies)
        this.connect()
      },
      complete: () => {
        console.log('Monitor complete')
      },
      error: (err) => {
        console.error('Error in monitor', err)
      },
    })
  }

  private process(): Subscription {
    const socketIsOpen = this.client.pipe(
      filter((socket) => {
        return socket?.readyState === WebSocket.OPEN
      }),
      take(1)
    )

    const buffered = this.queue.pipe(
      bufferWhen(() => socketIsOpen),
      filter((buffer) => buffer.length > 0),
      map((buffer) => {
        // Sort to send requests with config first
        return buffer.sort((a, b) => {
          const hasConfig = (req: pb.WebsocketRequest) =>
            !!req.payload.value?.config
          return hasConfig(b) ? 1 : hasConfig(a) ? -1 : 0
        })
      })
    )

    // Pass through messages that arrive after the socket is open
    const passthrough = this.queue.pipe(skipUntil(socketIsOpen))

    // Merge the buffered and passthrough streams
    const merged = merge(
      // Flatten buffered arrays
      buffered.pipe(
        // Use mergeMap to flatten
        mergeMap((buffer) => buffer)
      ),
      passthrough
    )

    const sender = merged.pipe(
      withLatestFrom(this.client),
      takeWhile(([, socket]) => socket.readyState === WebSocket.OPEN),
      mergeMap(async ([req, socket]) => {
        await sendWebsocketRequest({
          req,
          interceptors: this.interceptors,
          socket,
          knownID: this.knownID,
          runID: this.runID,
        })
      })
    )

    return sender.subscribe({
      error: (err) => {
        this._errors.next(err)
      },
    })
  }

  // Creates a new socket client for the given streamID.
  // Returns an observable that emits the socket when it is open.
  // The socket is closed when the observable is unsubscribed.
  private useSocketClient(streamID: string) {
    return new Observable<WebSocket>((observer) => {
      const url = new URL(this.runnerEndpoint)
      url.searchParams.set('id', streamID)
      url.searchParams.set('runID', this.runID)
      const socket = new WebSocket(url.toString())

      // Define event handlers
      const onClose = (event: CloseEvent) => {
        console.log(new Date(), `WebSocket transport ${streamID} closed`, event)
        if (event.code === 1005) {
          observer.complete()
          return
        }

        if (this.autoReconnect) {
          // This infinite loop is throttled by the reconnect subject.
          this.connect()
          return
        }
      }

      const onError = (event: Event) => {
        console.log(new Date(), `WebSocket transport ${streamID} error`, event)
        // If autoReconnect is disabled, we want to error out immediately.
        if (!this.autoReconnect) {
          observer.error(event)
        }
      }

      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') {
          console.warn('Unexpected WebSocket message type:', typeof event.data)
          return
        }
        let message: pb.WebsocketResponse
        try {
          message = parseWebsocketResponse(event.data)
          // Use the message
          console.log('Received WebsocketResponse:', message)
        } catch (err) {
          console.error('Failed to parse WebsocketResponse:', err)
        }

        const status = message!.status
        if (status && status.code !== Code.OK) {
          observer.error(status)
          return
        }

        // Pong is noop
        if (message!.pong) {
          // We could measure latency here
          return
        }

        const response = message!.payload.value as ExecuteResponse
        if (response.stdoutData && response.stdoutData.length > 0) {
          this.callback?.({
            type: ClientMessages.terminalStdout,
            output: {
              'runme.dev/id': this.knownID,
              data: response.stdoutData,
            },
          } as any)
          this._stdout.next(response.stdoutData)
        }

        if (response.stderrData && response.stderrData.length > 0) {
          this.callback?.({
            type: ClientMessages.terminalStderr,
            output: {
              'runme.dev/id': this.knownID,
              data: response.stderrData,
            },
          } as any)
          this._stderr.next(response.stderrData)
        }

        if (response.exitCode !== undefined) {
          this._exitCode.next(response.exitCode)
          observer.complete()
        }

        if (response.pid !== undefined) {
          this._pid.next(response.pid)
        }

        if (response.mimeType) {
          const parts = response.mimeType.split(';')
          const mimeType = parts[0]
          this._mimeType.next(mimeType)
        }
      }

      const onOpen = () => {
        console.log(
          new Date(),
          `✅ Connected WebSocket for cell ${this.knownID} (#${this.sequence}) with runID ${this.runID}`
        )

        observer.next(socket)
      }

      // Attach event listeners
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('open', onOpen)

      return () => {
        console.log(
          new Date(),
          `☑️ Cleanly disconnected WebSocket for cell ${this.knownID} (#${this.sequence}) with runID ${this.runID}`
        )
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('open', onOpen)
        socket.close()
      }
    })
  }

  public setCallback(callback: VSCodeEvent<any>) {
    this.callback = callback
  }

  public sendExecuteRequest(executeRequest: ExecuteRequest) {
    this.queue.next(
      create(pb.WebsocketRequestSchema, {
        payload: {
          value: executeRequest,
          case: 'executeRequest',
        },
      })
    )
  }

  // Sends periodic heartbeat pings to keep the WebSocket connection alive.
  // If heartbeat is Heartbeat.CONTINUOUS, sends an initial ping immediately and then every 10 seconds.
  // If heartbeat is Heartbeat.INITIAL, sends only a single immediate ping.
  private useHeartbeat(
    socket: WebSocket,
    { streamID, heartbeat }: ReconnectConfig
  ): Observable<WebSocket> {
    return new Observable<WebSocket>((observer) => {
      // Listen to the websocket's pongs
      const pongsWithReceipt = fromEvent<MessageEvent>(socket, 'message').pipe(
        takeWhile(() => socket.readyState === WebSocket.OPEN),
        map((event) => parseWebsocketResponse(event.data)),
        map((message) => message.pong),
        filter((pong) => pong !== undefined),
        map((pong) => ({
          receivedAt: BigInt(Date.now()),
          pong,
        }))
      )

      // Continuous heartbeat pings every HEARTBEAT_INTERVAL_MS
      const ticks =
        heartbeat === Heartbeat.INITIAL
          ? timer(0)
          : timer(0, HEARTBEAT_INTERVAL_MS)

      // Turn ticks into pings.
      const pings = ticks.pipe(
        takeWhile(() => socket.readyState === WebSocket.OPEN),
        map(() => {
          const ping = { timestamp: BigInt(Date.now()) }
          return create(pb.WebsocketRequestSchema, { ping })
        }),
        mergeMap(async (req: pb.WebsocketRequest) => {
          await sendWebsocketRequest({
            req,
            interceptors: this.interceptors,
            socket,
            // todo(sebastian): not including these saves payload size. do we need them?
            // knownID: this.knownID,
            // runID: this.runID,
          })
          return req
        }),
        map((req: pb.WebsocketRequest) => req.ping)
      )

      // For each ping, expect a pong within MAX_LATENCY_DEADLINE_MS
      const pingsWithTimeout = pings.pipe(
        filter((ping) => ping?.timestamp !== undefined),
        mergeMap((ping) =>
          race(
            pongsWithReceipt.pipe(
              filter(
                (pongReceipt) => pongReceipt.pong.timestamp === ping!.timestamp
              ),
              take(1),
              map((pongReceipt) => {
                const sent = ping!.timestamp
                const received = pongReceipt.receivedAt
                return Number(received - sent)
              })
            ),
            timer(MAX_LATENCY_DEADLINE_MS).pipe(
              map(() => {
                throw new Error(
                  `Pong not received within ${MAX_LATENCY_DEADLINE_MS}ms for stream ${streamID}`
                )
              })
            )
          ).pipe(
            catchError((err) => {
              // Emit a deadline latency to trigger a reconnect
              this._latencies.next({
                streamID,
                latency: MAX_LATENCY_DEADLINE_MS,
                readyState: socket.readyState,
                updatedAt: BigInt(Date.now()),
              })
              console.log(new Date(), `Ping deadline exceeded`, err.message)
              return of(null) // Continue stream
            })
          )
        ),
        finalize(() => {
          // Mark the stream's latency as closed; as per readyState
          this._latencies.next({
            streamID,
            latency: -1,
            readyState: socket.readyState,
            updatedAt: BigInt(Date.now()),
          })
        }),
        tap((ms) => {
          if (ms !== null) {
            this._latencies.next({
              streamID,
              latency: ms,
              readyState: socket.readyState,
              updatedAt: BigInt(Date.now()),
            })
          }
        })
      )

      const subs: Subscription[] = []

      subs.push(
        pingsWithTimeout.subscribe({
          error: (err) => {
            console.error('Unexpected error sending heartbeat', err)
          },
        })
      )

      observer.next(socket)

      return () => {
        subs.forEach((sub) => sub.unsubscribe())
      }
    })
  }

  // Returns an observable that emits the latency for the new stream.
  // If the stream is not found, null is emitted.
  public connect(heartbeat = Heartbeat.CONTINUOUS): Observable<Latency | null> {
    const streamID = genStreamID()
    const latency = this.latencies.pipe(
      map((latencies) => {
        const l = latencies.get(streamID)
        if (l === undefined) {
          return null
        }
        return l
      }),
      takeWhile((latency) => latency?.readyState === WebSocket.OPEN)
    )
    this.reconnect.next({ streamID, heartbeat })
    return latency
  }

  // Closes streams by completing the reconnect, queue, and latencies subjects.
  public close() {
    this.reconnect.complete()
    this.queue.complete()
    this._latencies.complete()
    this.subscriptions.forEach((sub) => sub.unsubscribe())
  }
}

// Parses a WebsocketResponse from a string.
function parseWebsocketResponse(data: string): pb.WebsocketResponse {
  // Parse the string into an object
  const parsed = JSON.parse(data)
  // Parse the payload into a Protobuf message
  return fromJson(pb.WebsocketResponseSchema, parsed)
}

// Sends a WebsocketRequest over a WebSocket after adding knownId, runId, and authorization.
async function sendWebsocketRequest({
  req,
  interceptors,
  socket,
  knownID,
  runID,
}: {
  req: pb.WebsocketRequest
  interceptors: Interceptor[]
  socket: WebSocket
  knownID?: string
  runID?: string
}) {
  // knownID tracks the origin cell/cell of the request.
  if (knownID) {
    req.knownId = knownID
  }
  // runID identifies the specific execution of the request.
  if (runID) {
    req.runId = runID
  }

  // Create a dummy unary request for interceptor compatibility
  const authzReq: UnaryRequest = {
    stream: false,
    message: {} as any, // Dummy message
    method: {} as any, // Dummy method
    service: {} as any, // Dummy service
    requestMethod: 'UPGRADE',
    url: socket.url,
    signal: new AbortController().signal,
    header: new Headers(),
    contextValues: {} as any,
  }

  let next: NextFunc = async (
    request: UnaryRequest | StreamRequest
  ): Promise<UnaryResponse | StreamResponse> => {
    return {
      stream: false,
      message: {} as any,
      method: {} as any,
      service: {} as any,
      // pass through the headers
      header: request.header,
    } as UnaryResponse
  }

  // Apply interceptors with proper typing
  for (const i of interceptors.concat().reverse()) {
    next = i(next as NextFunc)
  }

  // Call the final interceptor chain
  const appliedAuthzResp = await next(authzReq)

  // Websockets do not support authorization headers directly, so we add it to the request.
  // However, going the HTTP header route allows reusing interceptors across Connect and WebSockets.
  const authorization = appliedAuthzResp.header.get('Authorization')
  if (authorization && req) {
    req.authorization = authorization
  }
  socket.send(JSON.stringify(toJson(pb.WebsocketRequestSchema, req)))
}

// Generate a unique ID for the stream
export function genStreamID() {
  return uuidv4().replace(/-/g, '')
}

// Generate a unique ID for the run
export function genRunID() {
  return `run_${ulid()}`
}

export default Streams
