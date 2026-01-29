import { type Interceptor } from "@connectrpc/connect";

// TODO(jlewi): Did we end up using this?

// Runner implements the ConsoleRunner interface expected by @runmedev/react-console.
// It also carries a name so callers can reference runners by a human-friendly key.
export class Runner {
  readonly name: string;
  endpoint: string;
  reconnect: boolean;
  interceptors: Interceptor[];

  constructor({
    name,
    endpoint,
    reconnect = true,
    interceptors = [],
  }: {
    name: string;
    endpoint: string;
    reconnect?: boolean;
    interceptors?: Interceptor[];
  }) {
    this.name = name;
    this.endpoint = endpoint;
    this.reconnect = reconnect;
    this.interceptors = interceptors;
  }
}

export type RunnerMap = Map<string, Runner>;
