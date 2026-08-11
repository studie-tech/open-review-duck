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

  /** Derives the stable tenant-bound identity used before an upload starts. */
  customId(input: PutSourceObject) {
    return createHmac("sha256", this.storageIdKey)
      .update(input.workspaceId)
      .update("\0")
      .update(input.digest)
      .digest("base64url");
  }

  /** Uploads one opaque private object with a tenant-bound custom identifier. */
  async put(input: PutSourceObject): Promise<StoredObject> {
    const customId = this.customId(input);
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

  /** Checks one private object without transferring its contents. */
  async exists(objectKey: string) {
    const { ufsUrl } = await this.api.generateSignedURL(objectKey, {
      expiresIn: 60,
    });
    const response = await fetch(ufsUrl, {
      cache: "no-store",
      redirect: "error",
      headers: { range: "bytes=0-0" },
      signal: AbortSignal.timeout(15_000),
    });
    // A store that ignores Range answers 200 with the full body, so release it
    // rather than letting the response buffer behind an unread stream.
    await response.body?.cancel();
    // Only a deletion may answer false, because the caller responds by dropping
    // the row that is this object's last reference. A refused range still
    // proves the object is there: an empty one cannot satisfy bytes=0-0.
    if (response.status === 404 || response.status === 410) return false;
    if (response.ok || response.status === 416) return true;
    throw new Error(
      `UploadThing source presence check failed with ${response.status}`,
    );
  }

  /** Permanently deletes one private UploadThing object. */
  async delete(objectKey: string) {
    await this.api.deleteFiles(objectKey);
  }

  /** Deletes a crashed upload whose provider key was never persisted. */
  async deleteByCustomId(customId: string) {
    await this.api.deleteFiles(customId, { keyType: "customId" });
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
