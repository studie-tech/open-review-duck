import "server-only";

import { createHmac } from "node:crypto";
import { UTApi, UTFile } from "uploadthing/server";
import type { PutSourceObject, SourceObjectStore, StoredObject } from "./types";

/** Stores private SaaS source objects in the configured UploadThing application. */
export class UploadThingSourceObjectStore implements SourceObjectStore {
  readonly kind = "uploadthing" as const;
  private readonly api: UTApi;

  /** Creates a server-only private UploadThing client. */
  constructor(
    token: string,
    private readonly storageIdKey: string,
  ) {
    this.api = new UTApi({
      token,
      defaultKeyType: "fileKey",
      logLevel: "Error",
    });
  }

  /** Uploads one opaque private object with a tenant-bound custom identifier. */
  async put(input: PutSourceObject): Promise<StoredObject> {
    const customId = createHmac("sha256", this.storageIdKey)
      .update(input.workspaceId)
      .update("\0")
      .update(input.digest)
      .digest("base64url");
    const file = new UTFile([Buffer.from(input.bytes)], `${input.digest}.bin`, {
      customId,
      type: "application/octet-stream",
    });
    const uploaded = await this.api.uploadFiles(file, {
      acl: "private",
      contentDisposition: "inline",
    });
    if (uploaded.error || !uploaded.data) {
      throw new Error(
        `UploadThing source upload failed: ${uploaded.error?.message ?? "unknown error"}`,
      );
    }
    return {
      customId,
      objectKey: uploaded.data.key,
      storage: this.kind,
    };
  }

  /** Reads one private object through a five-minute server URL. */
  async read(objectKey: string) {
    const { ufsUrl } = await this.api.generateSignedURL(objectKey, {
      expiresIn: 300,
    });
    const response = await fetch(ufsUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`UploadThing source read failed with ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Permanently deletes one private UploadThing object. */
  async delete(objectKey: string) {
    await this.api.deleteFiles(objectKey);
  }

  /** Generates short-lived direct access without persisting the URL. */
  async createReadAccess(objectKey: string, expiresInSeconds: number) {
    const { ufsUrl } = await this.api.generateSignedURL(objectKey, {
      expiresIn: expiresInSeconds,
    });
    return {
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
      url: ufsUrl,
    };
  }
}
