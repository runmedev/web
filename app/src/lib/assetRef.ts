export const AISRE_ASSET_MIME = "application/vnd.openai.aisre-asset+json";

export type AssetRef = { uri: string; mimeType: string };

export function getAssetProxyUrl(baseUrl: string, ref: AssetRef): string {
  return `${baseUrl}/assets?ref=${encodeURIComponent(ref.uri)}&contentType=${encodeURIComponent(ref.mimeType)}`;
}
