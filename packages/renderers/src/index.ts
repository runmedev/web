import './components'
import { getContext, setContext } from './messaging'
import { ClientMessages } from './types'

export {
  default as Streams,
  type Authorization,
  type StreamsProps,
  type StreamsLike,
} from './streams'
export { genRunID, Heartbeat, type StreamError } from './streams'
export { FakeStreams } from './streams/fakeStreams'

export { ConsoleView, type ConsoleViewConfig } from './components/console'
export { type RunmeConsoleStream } from './components/console/runme'
export { setContext, getContext, ClientMessages }
