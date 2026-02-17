import {
  Code,
  ConnectError,
  type CallOptions,
  type Client,
  type Interceptor,
  createClient,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import {
  RunsService,
  type CreateRunRequest,
  type CreateRunResponse,
  type Run,
  type UpdateRunRequest,
  type UpdateRunResponse,
  type ListRunsRequest,
  type ListRunsResponse as ProtoListRunsResponse,
  type RunListItem as ProtoRunListItem,
} from "../protogen/oaiproto/aisre/runs_pb.js";
import {
  ParserService,
  type Notebook,
  type SerializeRequestOptions,
  type DeserializeRequestOptions,
} from "@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb.js";
import { timestampDate } from "@bufbuild/protobuf/wkt";

export const DEFAULT_RUNME_SERVER_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:9988"
    : window.location.origin;

export type RequestOptions = Omit<RequestInit, "body"> & {
  headers?: HeadersInit;
};

export interface AisreClientOptions {
  /**
   * Base URL used when constructing requests. Defaults to the runme server
   * running on http://localhost:9988 so the client can talk directly to the
   * backend during local development.
   */
  readonly baseUrl?: string;
  /**
   * Request options merged into every request. Useful for setting a default
   * mode or credentials policy.
   */
  readonly defaultOptions?: RequestOptions;
  /**
   * Returns an ID token to attach to requests. When provided the client will
   * automatically set the Authorization header for every call.
   */
  readonly getIdToken?: () => Promise<string | undefined>;
  /**
   * Additional interceptors applied to every call.
   */
  readonly interceptors?: readonly Interceptor[];
}

export interface ListRunsParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly query?: string;
}

export interface RunListItem {
  readonly name: string;
  readonly lastUpdated?: string;
}

export interface ListRunsResponse {
  readonly runs: RunListItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalRuns: number;
  readonly query?: string;
}

export class AisreClient {
  private readonly baseUrl: string;
  private readonly client: Client<typeof RunsService>;
  private readonly parserClient: Client<typeof ParserService>;
  private readonly defaultCallOptions?: CallOptions;
  private readonly defaultRequestOptions?: RequestOptions;
  private readonly fetchFn: typeof fetch;
  private readonly getIdToken?: () => Promise<string | undefined>;

  constructor(options: AisreClientOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_RUNME_SERVER_BASE_URL;
    this.baseUrl = stripTrailingSlashes(baseUrl);
    this.defaultCallOptions = buildCallOptions(options.defaultOptions);
    this.defaultRequestOptions = options.defaultOptions;
    this.getIdToken = options.getIdToken;

    const fetchConfig = createFetchWithDefaults(options.defaultOptions);
    const wrappedFetch = fetchConfig?.fetch;
    this.fetchFn = (input: RequestInfo | URL, init?: RequestInit) => {
      if (wrappedFetch) {
        return wrappedFetch(input, init);
      }
      return fetch(input, init);
    };

    const transport = createConnectTransport({
      baseUrl: resolveBaseUrl(this.baseUrl),
      useBinaryFormat: false,
      interceptors: this.buildInterceptors(options),
      ...(fetchConfig ?? {}),
    });

    this.client = createClient(RunsService, transport);
    this.parserClient = createClient(ParserService, transport);
  }

  /**
   * Fetches a run by name. Returns undefined when the run is not found rather
   * than surfacing a 404 to simplify callers.
   */
  async getRun(
    name: string,
    options?: RequestOptions,
  ): Promise<Run | undefined> {
    try {
      const response = await this.client.getRun(
        { name },
        this.mergeCallOptions(options),
      );
      return response.run ?? undefined;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async listRuns(params: ListRunsParams = {}): Promise<ListRunsResponse> {
    const request = {
      $typeName: "oaiproto.aisre.ListRunsRequest",
      page: params.page ?? 0,
      pageSize: params.pageSize ?? 0,
      query: params.query?.trim() ?? "",
    } as ListRunsRequest;

    const response = await this.client.listRuns(
      request,
      this.mergeCallOptions(),
    );

    return convertListRunsResponse(response);
  }

  createRun(
    request: CreateRunRequest,
    options?: RequestOptions,
  ): Promise<CreateRunResponse> {
    return this.client.createRun(request, this.mergeCallOptions(options));
  }

  updateRun(
    request: UpdateRunRequest,
    options?: RequestOptions,
  ): Promise<UpdateRunResponse> {
    return this.client.updateRun(request, this.mergeCallOptions(options));
  }

  /**
   * Deserializes raw bytes (e.g. Markdown content) into a Notebook via the
   * parser service.
   */
  async deserializeNotebook(
    source: Uint8Array,
    deserializeOptions?: DeserializeRequestOptions,
    requestOptions?: RequestOptions,
  ): Promise<Notebook> {
    const response = await this.parserClient.deserialize(
      {
        source,
        options: deserializeOptions,
      },
      this.mergeCallOptions(requestOptions),
    );
    return response.notebook!;
  }

  /**
   * Serializes a notebook via the parser service and returns the raw bytes
   * produced by the backend (e.g. Markdown content for an index file).
   */
  async serializeNotebook(
    notebook: Notebook,
    serializeOptions?: SerializeRequestOptions,
    requestOptions?: RequestOptions,
  ): Promise<Uint8Array> {
    const response = await this.parserClient.serialize(
      {
        notebook,
        options: serializeOptions,
      },
      this.mergeCallOptions(requestOptions),
    );
    return response.result;
  }

  private mergeCallOptions(
    overrides?: RequestOptions,
  ): CallOptions | undefined {
    const overrideCallOptions = buildCallOptions(overrides);
    return mergeCallOptions(this.defaultCallOptions, overrideCallOptions);
  }

  private buildInterceptors(options: AisreClientOptions): Interceptor[] {
    const interceptors: Interceptor[] = [];

    const { getIdToken, interceptors: extraInterceptors } = options;

    if (getIdToken) {
      interceptors.push(createAuthInterceptor(getIdToken));
    }

    if (extraInterceptors?.length) {
      interceptors.push(...extraInterceptors);
    }

    return interceptors;
  }
}

function mergeHeaders(
  ...headerSets: (HeadersInit | undefined)[]
): Headers | undefined {
  const merged = new Headers();
  let hasValue = false;

  for (const headerSet of headerSets) {
    if (!headerSet) {
      continue;
    }
    hasValue = true;

    if (headerSet instanceof Headers) {
      headerSet.forEach((value, key) => merged.set(key, value));
      continue;
    }

    if (Array.isArray(headerSet)) {
      for (const [key, value] of headerSet) {
        merged.set(key, value);
      }
      continue;
    }

    for (const [key, value] of Object.entries(headerSet)) {
      if (value !== undefined) {
        merged.set(key, value);
      }
    }
  }

  return hasValue ? merged : undefined;
}

function convertListRunsResponse(
  response: ProtoListRunsResponse,
): ListRunsResponse {
  return {
    runs: response.runs.map(convertRunListItem),
    page: response.page,
    pageSize: response.pageSize,
    totalRuns: response.totalRuns,
    query: response.query === "" ? undefined : response.query,
  };
}

function convertRunListItem(item: ProtoRunListItem): RunListItem {
  return {
    name: item.name,
    lastUpdated: timestampToIsoString(item.lastUpdated),
  };
}

function timestampToIsoString(
  timestamp?: ProtoRunListItem["lastUpdated"],
): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  try {
    return timestampDate(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.NotFound;
}

export function createAisreClient(options?: AisreClientOptions): AisreClient {
  return new AisreClient(options);
}

function buildCallOptions(options?: RequestOptions): CallOptions | undefined {
  if (!options) {
    return undefined;
  }

  const headers = mergeHeaders(options.headers);
  const signal = options.signal ?? undefined;
  const hasHeaders = headers !== undefined && !headersAreEmpty(headers);
  const hasSignal = signal !== undefined && signal !== null;

  if (!hasHeaders && !hasSignal) {
    return undefined;
  }

  const callOptions: CallOptions = {};
  if (hasHeaders && headers) {
    callOptions.headers = headers;
  }
  if (hasSignal && signal) {
    callOptions.signal = signal;
  }

  return callOptions;
}

function mergeCallOptions(
  base?: CallOptions,
  overrides?: CallOptions,
): CallOptions | undefined {
  if (!base && !overrides) {
    return undefined;
  }
  if (!base) {
    return overrides;
  }
  if (!overrides) {
    return base;
  }

  const headers = mergeHeaders(base.headers, overrides.headers);
  return {
    ...base,
    ...overrides,
    headers,
  };
}

function headersAreEmpty(headers: Headers): boolean {
  return headers.keys().next().done === true;
}

function createAuthInterceptor(
  getIdToken: () => Promise<string | undefined>,
): Interceptor {
  return (next) => async (request) => {
    const token = await getIdToken();
    if (token) {
      request.header.set("Authorization", `Bearer ${token}`);
    }
    return next(request);
  };
}

function createFetchWithDefaults(
  options?: RequestOptions,
): { fetch: typeof fetch } | undefined {
  if (!options) {
    return undefined;
  }

  const defaults: RequestInit = {};
  let hasDefaults = false;

  if (options.credentials !== undefined) {
    defaults.credentials = options.credentials;
    hasDefaults = true;
  }
  if (options.cache !== undefined) {
    defaults.cache = options.cache;
    hasDefaults = true;
  }
  if (options.mode !== undefined) {
    defaults.mode = options.mode;
    hasDefaults = true;
  }
  if (options.redirect !== undefined) {
    defaults.redirect = options.redirect;
    hasDefaults = true;
  }
  if (options.referrer !== undefined) {
    defaults.referrer = options.referrer;
    hasDefaults = true;
  }
  if (options.referrerPolicy !== undefined) {
    defaults.referrerPolicy = options.referrerPolicy;
    hasDefaults = true;
  }
  if (options.keepalive !== undefined) {
    defaults.keepalive = options.keepalive;
    hasDefaults = true;
  }
  if (options.integrity !== undefined) {
    defaults.integrity = options.integrity;
    hasDefaults = true;
  }

  if (!hasDefaults) {
    return undefined;
  }

  return {
    fetch: (input, init) => fetch(input, { ...defaults, ...init }),
  };
}

function resolveBaseUrl(baseUrl: string): string {
  if (baseUrl === "") {
    return "/";
  }
  return baseUrl;
}
