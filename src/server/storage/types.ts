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
  customId?(input: PutSourceObject): string;
  put(input: PutSourceObject): Promise<StoredObject>;
  read(objectKey: string): Promise<Uint8Array>;
  exists?(objectKey: string): Promise<boolean>;
  delete(objectKey: string): Promise<void>;
  deleteByCustomId?(customId: string): Promise<void>;
  createReadAccess(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<{ expiresAt: Date; url?: string }>;
}
