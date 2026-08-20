import type {
  BinaryBody,
  DriveResourceFetchOptions,
  DriveResourceMetadata,
  DriveResourceUploadOptions,
} from '../storage/drive'

export type { DriveResourceMetadata }

export interface DriveResourceStore {
  getPrincipal(): Promise<{ permissionId: string }>
  uploadResource(
    parentUri: string,
    name: string,
    body: BinaryBody,
    options: DriveResourceUploadOptions
  ): Promise<DriveResourceMetadata>
  getResourceMetadata(uri: string): Promise<DriveResourceMetadata>
  fetchResource?(
    uri: string,
    options?: DriveResourceFetchOptions
  ): Promise<Response>
  fetch(uri: string, options?: DriveResourceFetchOptions): Promise<Response>
  resolveAssetFolder?(
    notebookUri: string,
    notebookName: string
  ): Promise<string>
}
