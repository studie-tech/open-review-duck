import { isLikelyBinaryFile, type SourceFile } from "~/server/analysis/types";

export interface ProviderSourceCandidate {
  file: SourceFile;
  oversizedHash?: string;
}

export interface ChangedSourceLoad {
  path: string;
  fetchPath?: string;
  previousFetchPath?: string;
  ref: string;
  previousRef: string;
  changeType: NonNullable<SourceFile["changeType"]>;
  needsPrevious: boolean;
  oversizedHash: string;
  contentBinaryHash?: (content: string) => string;
  getFileContent: (path: string, ref: string) => Promise<string | undefined>;
}

interface RetainedProviderSource {
  index: number;
  bytes: number;
  skippedFile: SourceFile;
}

/** Breaks equal-size ties by original position so completion order is irrelevant. */
function compareRetainedSource(
  a: RetainedProviderSource,
  b: RetainedProviderSource,
) {
  return a.bytes - b.bytes || a.index - b.index;
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
    if (!parentSource || compareRetainedSource(parentSource, source) >= 0)
      break;
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
      rightSource && compareRetainedSource(rightSource, leftSource) > 0
        ? right
        : left;
    const childSource = heap[child];
    if (!childSource || compareRetainedSource(childSource, last) <= 0) break;
    heap[index] = childSource;
    index = child;
  }
  heap[index] = last;
  return largest;
}

const PROVIDER_SOURCE_CONCURRENCY = 8;

/** Fetches one changed source, sniffing binaries and skipping missing revisions. */
export async function loadChangedSource(
  request: ChangedSourceLoad,
): Promise<ProviderSourceCandidate> {
  const fetchPath = request.fetchPath ?? request.path;
  const previousFetchPath = request.previousFetchPath ?? request.path;
  const skippedFile: SourceFile = {
    path: request.path,
    content: "",
    skipReason: "too_large",
    isBinary: false,
    binaryHash: request.oversizedHash,
    changeType: request.changeType,
  };
  if (isLikelyBinaryFile(request.path)) {
    return {
      file: {
        path: request.path,
        content: "",
        isBinary: true,
        binaryHash: request.oversizedHash,
        changeType: request.changeType,
      },
    };
  }
  const content = await request.getFileContent(fetchPath, request.ref);
  if (content === undefined) return { file: skippedFile };
  if (isLikelyBinaryFile(request.path, content)) {
    return {
      file: {
        path: request.path,
        content: "",
        isBinary: true,
        binaryHash:
          request.contentBinaryHash?.(content) ?? request.oversizedHash,
        changeType: request.changeType,
      },
    };
  }
  const previousContent = request.needsPrevious
    ? await request.getFileContent(previousFetchPath, request.previousRef)
    : undefined;
  if (request.needsPrevious && previousContent === undefined) {
    return { file: skippedFile };
  }
  return {
    file: {
      path: request.path,
      content,
      previousContent,
      isBinary: false,
      changeType: request.changeType,
    },
    oversizedHash: request.oversizedHash,
  };
}

/** Loads provider files concurrently and retains the smallest sources in budget. */
export async function collectProviderSourceFiles<T>(
  values: readonly T[],
  maximumSourceBytes: number | undefined,
  load: (value: T) => Promise<ProviderSourceCandidate>,
) {
  const files = new Array<SourceFile>(values.length);
  const retainedSources: RetainedProviderSource[] = [];
  let usedSourceBytes = 0;
  const normalizedMaximum =
    maximumSourceBytes === undefined
      ? undefined
      : Math.max(0, maximumSourceBytes);
  let cursor = 0;
  let stopped = false;
  // Consume each result as soon as it finishes. Slow files no longer leave
  // the other seven slots idle, and completed source is budgeted immediately.
  await Promise.all(
    Array.from(
      { length: Math.min(PROVIDER_SOURCE_CONCURRENCY, values.length) },
      async () => {
        while (!stopped && cursor < values.length) {
          const index = cursor++;
          try {
            const candidate = await load(values[index] as T);
            const file = candidate.file;
            if (file.isBinary || file.skipReason) {
              files[index] = file;
              continue;
            }
            const sourceBytes =
              Buffer.byteLength(file.content) +
              Buffer.byteLength(file.previousContent ?? "");
            files[index] = file;
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
          } catch (cause) {
            stopped = true;
            throw cause;
          }
        }
      },
    ),
  );
  return files;
}
