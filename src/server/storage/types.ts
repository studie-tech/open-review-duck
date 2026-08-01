export interface StoredObject {
  customId?: string;
  objectKey: string;
  storage: "local" | "uploadthing";
}

export interface PutSourceObject {
  bytes: Uint8Array;
  digest: string;
  workspaceId: string;
}

export interface SourceObjectStore {
  readonly kind: StoredObject["storage"];
  put(input: PutSourceObject): Promise<StoredObject>;
  read(objectKey: string): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
  createReadAccess(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<{ expiresAt: Date; url?: string }>;
}
