import "server-only";

import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { UTApi, UTFile } from "uploadthing/server";
import type { PutSourceObject, SourceObjectStore, StoredObject } from "./types";

const SOURCE_UPLOAD_ATTEMPTS = 3;
const SOURCE_UPLOAD_RETRY_MILLISECONDS = 250;

/** Removes provider URLs that may contain short-lived credentials. */
function redactProviderUrls(value: string) {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]");
}

/** Finds a bounded HTTP status without retaining a provider response body. */
function uploadFailureStatus(
  value: unknown,
  depth = 0,
  visited = new Set<object>(),
): number | undefined {
  if (!value || typeof value !== "object" || depth > 3 || visited.has(value)) {
    return undefined;
  }
  visited.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode"]) {
    const status = record[key];
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return status;
    }
  }
  for (const key of ["response", "cause", "error", "data"]) {
    const status = uploadFailureStatus(record[key], depth + 1, visited);
    if (status !== undefined) return status;
  }
  return undefined;
}

/** Retains actionable UploadThing context without persisting signed URLs. */
function uploadFailureMessage(cause: unknown) {
  const record =
    cause && typeof cause === "object"
      ? (cause as Record<string, unknown>)
      : undefined;
  const message =
    (typeof record?.message === "string" && record.message.trim()) ||
    (cause instanceof Error && cause.message.trim()) ||
    "unknown error";
  const code =
    typeof record?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(record.code)
      ? record.code
      : undefined;
  const status = uploadFailureStatus(cause);
  const context = [code, status ? `HTTP ${status}` : undefined].filter(Boolean);
  return `UploadThing source upload failed: ${redactProviderUrls(message).slice(0, 160)}${context.length ? ` (${context.join(", ")})` : ""}`;
}

/** Formats a bounded cleanup failure without leaking provider request data. */
function cleanupFailureMessage(cause: unknown) {
  const record =
    cause && typeof cause === "object"
      ? (cause as Record<string, unknown>)
      : undefined;
  const code =
    typeof record?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(record.code)
      ? record.code
      : undefined;
  const status = uploadFailureStatus(cause);
  return (
    [code, status ? `HTTP ${status}` : undefined].filter(Boolean).join(", ") ||
    "provider cleanup request failed"
  );
}

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

  /** Derives the tenant- and lease-bound identity used before an upload starts. */
  customId(input: PutSourceObject) {
    const identity = createHmac("sha256", this.storageIdKey)
      .update(input.workspaceId)
      .update("\0")
      .update(input.digest);
    if (input.attemptId) identity.update("\0").update(input.attemptId);
    return identity.digest("base64url");
  }

  /** Uploads one opaque private object with a tenant-bound custom identifier. */
  async put(input: PutSourceObject): Promise<StoredObject> {
    const customId = this.customId(input);
    let lastFailure = "UploadThing source upload failed: unknown error";
    for (let attempt = 1; attempt <= SOURCE_UPLOAD_ATTEMPTS; attempt++) {
      try {
        const file = new UTFile(
          [Buffer.from(input.bytes)],
          `${input.digest}.bin`,
          {
            customId,
            type: "application/octet-stream",
          },
        );
        const uploaded = await this.api.uploadFiles(file, {
          acl: "private",
          contentDisposition: "inline",
        });
        if (!uploaded.error && uploaded.data) {
          return {
            customId,
            objectKey: uploaded.data.key,
            storage: this.kind,
          };
        }
        lastFailure = uploadFailureMessage(uploaded.error);
      } catch (cause) {
        lastFailure = uploadFailureMessage(cause);
      }

      // The ingest request may have committed before its response was lost.
      // Adopt that object before deleting anything: its lease-bound custom ID
      // proves it came from this call, while the database still verifies the
      // content digest when the object is read.
      try {
        const committed = await this.api.getFileUrls(customId, {
          keyType: "customId",
        });
        const objectKey = committed.data[0]?.key;
        if (objectKey) return { customId, objectKey, storage: this.kind };
      } catch {
        // This deprecated lookup is recovery-only. Its outage must not hide
        // the actionable upload error or prevent the bounded retry below.
      }

      // No committed object was visible. Removing this upload lease's custom
      // identity makes the next in-call attempt genuine; a later database
      // lease receives a new identity even if provider deletion is delayed.
      try {
        await this.deleteByCustomId(customId);
      } catch (cause) {
        lastFailure = `${lastFailure}; custom-ID cleanup failed: ${cleanupFailureMessage(cause)}`;
      }
      if (attempt < SOURCE_UPLOAD_ATTEMPTS) {
        await delay(SOURCE_UPLOAD_RETRY_MILLISECONDS * 2 ** (attempt - 1));
      }
    }
    throw new Error(lastFailure);
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
