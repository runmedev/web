import { getAuthData } from "../token.js";
import {
  DEFAULT_RUNME_SERVER_BASE_URL,
  createAisreClient,
  type AisreClientOptions,
} from "./aisreClient.js";
import { useMemo } from "react";
import { useAgentEndpointSnapshot } from "./agentEndpointManager";

// TODO(jlewi): I think this is using ReactContexts to manage and keep track of AisreClients.
// I'm not sure I like that pattern because it starts injecting react constructs into libraries
// that should be framework agnostic. I think a better pattern is the newly added AisreClientManager
// which is a singleton that can be used to get AisreClients. That can then be updated in response to
// settings changes by higher level code in the React app.

export function useBaseUrl() {
  const agentEndpoint = useAgentEndpointSnapshot();
  return useMemo(
    () => normalizeBaseUrl(agentEndpoint.endpoint),
    [agentEndpoint.endpoint],
  );
}

export function useAisreClient(options?: Pick<AisreClientOptions, "baseUrl">) {
  const agentEndpoint = useAgentEndpointSnapshot();
  const baseUrl = useMemo(
    () => normalizeBaseUrl(agentEndpoint.endpoint),
    [agentEndpoint.endpoint],
  );

  const client = useMemo(() => createClient({ baseUrl }), [baseUrl]);

  return client;
}

function createClient(options: Pick<AisreClientOptions, "baseUrl">) {
  return createAisreClient({
    ...options,
    getIdToken: async () => (await getAuthData())?.idToken ?? undefined,
  });
}

function normalizeBaseUrl(agentEndpoint?: string | null): string {
  const trimmed = agentEndpoint?.trim();
  if (!trimmed) {
    return DEFAULT_RUNME_SERVER_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}
