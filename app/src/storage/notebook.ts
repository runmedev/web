import { parser_pb } from "../runme/client";

export enum NotebookStoreItemType {
  File = "file",
  Folder = "folder",
}

export interface NotebookStoreItem {
  uri: string;
  name: string;
  type: NotebookStoreItemType;
  children: string[];
  remoteUri?: string;
  parents: string[];
}

export interface NotebookStore {
  save(uri: string, notebook: parser_pb.Notebook): Promise<void>;
  load(uri: string): Promise<parser_pb.Notebook>;
  list(uri: string): Promise<NotebookStoreItem[]>;
  getType(uri: string): Promise<NotebookStoreItemType>;
  create(parentUri: string, name: string): Promise<NotebookStoreItem>;
  rename(uri: string, name: string): Promise<NotebookStoreItem>;
  getMetadata(uri: string): Promise<NotebookStoreItem | null>;
}
