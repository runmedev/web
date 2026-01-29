import { useMemo } from "react";

import type { Run } from "../protogen/oaiproto/aisre/runs_pb.js";

import { useQuery } from "@tanstack/react-query";
import { useAisreClient } from "./useAisreClient.js";

export interface UseRunOptions {
  readonly enabled?: boolean;
  readonly refetchInterval?: (
    run: Run | undefined,
  ) => number | false | undefined;
}

export function useRun(runName?: string, options?: UseRunOptions) {
  const client = useAisreClient();
  const normalizedRunName = useMemo(() => runName?.trim() ?? "", [runName]);

  return useQuery({
    enabled: normalizedRunName !== "" && options?.enabled !== false,
    queryKey: ["run", normalizedRunName],
    queryFn: () => client.getRun(normalizedRunName),
    refetchInterval: (query) => {
      if (query.state.error) {
        return false;
      }
      return options?.refetchInterval?.(query.state.data) ?? false;
    },
  });
}
