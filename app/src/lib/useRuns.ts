import { useMemo } from "react";

import { useQuery, keepPreviousData } from "@tanstack/react-query";

import { useAisreClient } from "./useAisreClient.js";
import { type ListRunsParams, type ListRunsResponse } from "./aisreClient.js";

export const DEFAULT_RUNS_PAGE_SIZE = 10;

export interface UseRunsOptions {
  readonly enabled?: boolean;
}

export function useRuns(params: ListRunsParams, options?: UseRunsOptions) {
  const client = useAisreClient();
  const normalizedParams = useMemo(() => {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_RUNS_PAGE_SIZE;
    const query = params.query?.trim() ?? "";

    return {
      page: page > 0 ? page : 1,
      pageSize: pageSize > 0 ? pageSize : DEFAULT_RUNS_PAGE_SIZE,
      query: query === "" ? undefined : query,
    } satisfies ListRunsParams;
  }, [params.page, params.pageSize, params.query]);

  return useQuery<ListRunsResponse, Error>({
    queryKey: ["runs", normalizedParams],
    queryFn: () => client.listRuns(normalizedParams),
    placeholderData: keepPreviousData,
    enabled: options?.enabled !== false,
  });
}
