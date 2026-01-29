export type OAuthTokenEndpointResponse = {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
};

export type StoredTokenResponse = OAuthTokenEndpointResponse & {
  expires_at?: number;
};

export type SimpleAuthJSONWithHelpers = {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: number;
  isExpired: () => boolean;
  willExpireSoon: (thresholdSeconds?: number) => boolean;
};
