import type { SourceFile } from "~/server/analysis/types";

export interface ProviderSourceCandidate {
  file: SourceFile;
  oversizedHash?: string;
}

interface RetainedProviderSource {
  index: number;
  bytes: number;
  skippedFile: SourceFile;
}

/** Adds one retained source to a max-heap ordered by combined source bytes. */
function retainProviderSource(
  heap: RetainedProviderSource[],
  source: RetainedProviderSource,
) {
  heap.push(source);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentSource = heap[parent];
    if (!parentSource || parentSource.bytes >= source.bytes) break;
    heap[index] = parentSource;
    index = parent;
  }
  heap[index] = source;
}

/** Removes and returns the largest retained source from a max-heap. */
function removeLargestProviderSource(heap: RetainedProviderSource[]) {
  const largest = heap[0];
  const last = heap.pop();
  if (!largest || !last || heap.length === 0) return largest;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const leftSource = heap[left];
    const rightSource = heap[right];
    if (!leftSource) break;
    const child =
      rightSource && rightSource.bytes > leftSource.bytes ? right : left;
    const childSource = heap[child];
    if (!childSource || childSource.bytes <= last.bytes) break;
    heap[index] = childSource;
    index = child;
  }
  heap[index] = last;
  return largest;
}

/** Loads provider files sequentially and retains the smallest sources in budget. */
export async function collectProviderSourceFiles<T>(
  values: readonly T[],
  maximumSourceBytes: number | undefined,
  load: (value: T) => Promise<ProviderSourceCandidate>,
) {
  const files: SourceFile[] = [];
  const retainedSources: RetainedProviderSource[] = [];
  let usedSourceBytes = 0;
  const normalizedMaximum =
    maximumSourceBytes === undefined
      ? undefined
      : Math.max(0, maximumSourceBytes);
  for (const value of values) {
    const candidate = await load(value);
    const file = candidate.file;
    if (file.isBinary || file.skipReason) {
      files.push(file);
      continue;
    }
    const sourceBytes =
      Buffer.byteLength(file.content) +
      Buffer.byteLength(file.previousContent ?? "");
    const index = files.push(file) - 1;
    usedSourceBytes += sourceBytes;
    retainProviderSource(retainedSources, {
      index,
      bytes: sourceBytes,
      skippedFile: {
        ...file,
        content: "",
        previousContent: undefined,
        skipReason: "too_large",
        isBinary: false,
        binaryHash:
          candidate.oversizedHash ??
          file.binaryHash ??
          `${file.path}:${file.changeType ?? "modified"}`,
      },
    });
    while (
      normalizedMaximum !== undefined &&
      usedSourceBytes > normalizedMaximum
    ) {
      const removed = removeLargestProviderSource(retainedSources);
      if (!removed) break;
      files[removed.index] = removed.skippedFile;
      usedSourceBytes -= removed.bytes;
    }
  }
  return files;
}
