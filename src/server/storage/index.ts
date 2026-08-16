import "server-only";

import path from "node:path";
import { env } from "~/env";
import { isLocalDeployment } from "~/server/deployment";
import { LocalSourceObjectStore } from "./local";
import type { SourceObjectStore } from "./types";

let sourceStore: SourceObjectStore | undefined;

/** Resolves the one object-store adapter selected by the deployment target. */
export async function sourceObjectStore(): Promise<SourceObjectStore> {
  if (sourceStore) return sourceStore;
  if (isLocalDeployment()) {
    sourceStore = new LocalSourceObjectStore(
      path.join(env.LOCAL_DATA_DIR, "objects"),
    );
    return sourceStore;
  }
  if (!env.UPLOADTHING_TOKEN || !env.STORAGE_ID_KEY) {
    throw new Error(
      "SaaS source storage requires UPLOADTHING_TOKEN and STORAGE_ID_KEY",
    );
  }
  const { UploadThingSourceObjectStore } = await import("./uploadthing");
  sourceStore = new UploadThingSourceObjectStore(
    env.UPLOADTHING_TOKEN,
    env.STORAGE_ID_KEY,
  );
  return sourceStore;
}

export type { SourceObjectStore } from "./types";
