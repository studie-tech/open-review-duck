import { mapWithLimit } from "~/lib/concurrency";
import {
  analyzeFiles,
  CURRENT_ANALYSIS_VERSION,
  extractFileAnalysis,
  extractFileImports,
} from "~/server/analysis/engine";
import { languageAdapterForFile } from "~/server/analysis/parsers";
import {
  type TreeSitterLanguage,
  withPreparedTreeSitterLanguages,
} from "~/server/analysis/tree-sitter";
import type { SourceFile } from "~/server/analysis/types";
import { sourceDigest } from "~/server/storage/source-blobs";
import {
  type createSyncArtifactCache,
  syncArtifactKey,
} from "./artifact-cache";

/** Reuses file-local extraction while rebuilding all revision-wide dependency facts. */
export async function analyzeFilesIncrementally(
  files: SourceFile[],
  cache: Awaited<ReturnType<typeof createSyncArtifactCache>>,
) {
  const extracted = new Map<string, ReturnType<typeof extractFileAnalysis>>();
  const missing = [] as typeof files;
  const imports = new Map<string, ReturnType<typeof extractFileImports>>();
  const analysisKeys = new Map(
    files.map((file) => [
      file.path,
      syncArtifactKey("file-analysis-v2", [
        CURRENT_ANALYSIS_VERSION,
        {
          ...file,
          content: sourceDigest(Buffer.from(file.content)),
          previousContent:
            file.previousContent === undefined
              ? null
              : sourceDigest(Buffer.from(file.previousContent)),
        },
      ]),
    ]),
  );
  await mapWithLimit(files, 8, async (file) => {
    const cached = await cache.read(analysisKeys.get(file.path) ?? "");
    if (cached !== undefined) {
      try {
        const facts = JSON.parse(cached) as {
          units: ReturnType<typeof extractFileAnalysis>;
          imports: ReturnType<typeof extractFileImports>;
        };
        const { units } = facts;
        if (
          !Array.isArray(units) ||
          !Array.isArray(facts.imports) ||
          units.some(
            (unit) =>
              unit.path !== file.path ||
              !Array.isArray(unit.dependencies) ||
              typeof unit.source !== "string" ||
              typeof unit.stableKey !== "string" ||
              typeof unit.contentHash !== "string" ||
              typeof unit.semanticHash !== "string" ||
              !Number.isInteger(unit.startLine) ||
              !Number.isInteger(unit.endLine),
          )
        )
          throw new Error("Invalid cached analysis");
        extracted.set(file.path, units);
        imports.set(file.path, facts.imports);
        cache.metrics.analysisReused++;
        return;
      } catch {
        /* An invalid checkpoint never blocks a fresh extraction. */
      }
    }
    missing.push(file);
  });

  if (missing.length)
    await withPreparedTreeSitterLanguages(
      missing
        .map((file) => languageAdapterForFile(file)?.language)
        .filter((language): language is TreeSitterLanguage =>
          Boolean(language && language !== "text"),
        ),
      async () => {
        await mapWithLimit(missing, 4, async (file) => {
          const units = extractFileAnalysis(file);
          const references = extractFileImports(file);
          extracted.set(file.path, units);
          imports.set(file.path, references);
          cache.metrics.analysisExtracted++;
          await cache.write(
            analysisKeys.get(file.path) ?? "",
            JSON.stringify({ units, imports: references }),
          );
        });
      },
    );
  // Rebuild imports, symbol ambiguity, ordering and concepts for the whole PR.
  // Only file-local extraction is reusable across revisions.
  return analyzeFiles(files, undefined, extracted, imports);
}
