import "server-only";

import { mkdir, open, readFile, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { PutSourceObject, SourceObjectStore, StoredObject } from "./types";

const DIGEST = /^[a-f0-9]{64}$/;
const WORKSPACE = /^[a-f0-9-]{1,64}$/i;

/** Stores source objects in an installation-owned directory without symlink traversal. */
export class LocalSourceObjectStore implements SourceObjectStore {
  readonly kind = "local" as const;

  /** Creates a store rooted at one installation-owned directory. */
  constructor(private readonly root: string) {}

  /** Writes one immutable workspace-scoped object atomically. */
  async put(input: PutSourceObject): Promise<StoredObject> {
    const objectKey = this.key(input.workspaceId, input.digest);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const disk = await statfs(this.root);
    const freeBytes = disk.bavail * disk.bsize;
    if (freeBytes < Math.max(256 * 1024 * 1024, input.bytes.byteLength * 2)) {
      throw new Error("Local storage is critically low on free disk space");
    }
    const target = this.resolve(objectKey);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(input.bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
    } catch (cause) {
      await rm(temporary, { force: true });
      try {
        await readFile(target);
      } catch {
        throw cause;
      }
    }
    return { objectKey, storage: this.kind };
  }

  /** Reads one previously validated object key. */
  async read(objectKey: string) {
    return new Uint8Array(await readFile(this.resolve(objectKey)));
  }

  /** Deletes one previously validated object key idempotently. */
  async delete(objectKey: string) {
    await rm(this.resolve(objectKey), { force: true });
  }

  /** Returns local expiry metadata without exposing a transferable URL. */
  async createReadAccess(_objectKey: string, expiresInSeconds: number) {
    return { expiresAt: new Date(Date.now() + expiresInSeconds * 1_000) };
  }

  /** Derives a tenant-scoped content-addressed object key. */
  private key(workspaceId: string, digest: string) {
    if (!WORKSPACE.test(workspaceId) || !DIGEST.test(digest)) {
      throw new Error("Invalid local source object identity");
    }
    return `${workspaceId}/${digest.slice(0, 2)}/${digest}`;
  }

  /** Resolves a key while proving it remains below the storage root. */
  private resolve(objectKey: string) {
    const target = path.resolve(this.root, objectKey);
    const prefix = `${path.resolve(this.root)}${path.sep}`;
    if (!target.startsWith(prefix)) {
      throw new Error("Source object path escapes the storage root");
    }
    return target;
  }
}
