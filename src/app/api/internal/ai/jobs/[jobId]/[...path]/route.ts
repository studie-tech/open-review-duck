import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { aiJobs, reviewSnapshots, reviewUnits } from "@/drizzle/schema";
import { env } from "~/env";
import {
  constrainAnnotationToChangedLines,
  explanationChangedLineRanges,
} from "~/server/ai/change-scope";
import { setSafeProxyHeader } from "~/server/ai/proxy-headers";
import { providerProxyTarget } from "~/server/ai/proxy-url";
import { acceptAiJobResult, getAiJobConfiguration } from "~/server/ai/service";
import { db } from "~/server/db";
import { safeRemoteFetch } from "~/server/security/remote-url";
import { aiResultSchema } from "~/validators/ai";

/** Checks whether an internal AI request carries the expected bearer token. */
function authorized(request: NextRequest) {
  const received =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-reviewduck-internal");
  if (!received) return false;
  const expectedBuffer = Buffer.from(env.FLUE_INTERNAL_SECRET);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/** Proxies one BYOK request through the DNS-pinned control-plane transport. */
async function proxyModelRequest(
  request: NextRequest,
  jobId: string,
  path: string[],
) {
  const configuration = await getAiJobConfiguration(db, jobId);
  if (
    !configuration ||
    configuration.useManagedModels ||
    !configuration.baseUrl
  ) {
    return new NextResponse(null, { status: 404 });
  }
  const target = providerProxyTarget(configuration.baseUrl, path.slice(1));
  for (const [name, value] of request.nextUrl.searchParams) {
    target.searchParams.set(
      name,
      name === "key" &&
        configuration.apiProtocol === "google-generative-ai" &&
        configuration.apiKey
        ? configuration.apiKey
        : value,
    );
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    setSafeProxyHeader(headers, name, value);
  }
  for (const [name, value] of Object.entries(configuration.headers ?? {})) {
    setSafeProxyHeader(headers, name, value);
  }
  if (configuration.apiKey) {
    if (configuration.apiProtocol === "anthropic-messages") {
      headers.set("x-api-key", configuration.apiKey);
    } else if (configuration.apiProtocol === "azure-openai-responses") {
      headers.set("api-key", configuration.apiKey);
    } else if (configuration.apiProtocol === "google-generative-ai") {
      target.searchParams.set("key", configuration.apiKey);
    } else {
      headers.set("authorization", `Bearer ${configuration.apiKey}`);
    }
  }
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  const upstream = await safeRemoteFetch(
    target.toString(),
    { method: request.method, headers, body, signal: request.signal },
    env.ALLOW_PRIVATE_AI_HOSTS,
  );
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** Loads nearby review units used as context for an AI job. */
async function contextUnits(jobId: string) {
  const job = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, jobId),
  });
  if (!job) return null;
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: and(
      eq(reviewSnapshots.id, job.snapshotId),
      eq(reviewSnapshots.pullRequestId, job.pullRequestId),
    ),
  });
  if (!snapshot) return null;
  let units: (typeof reviewUnits.$inferSelect)[];
  if (job.unitId) {
    const selectedUnit = await db.query.reviewUnits.findFirst({
      where: and(
        eq(reviewUnits.snapshotId, snapshot.id),
        eq(reviewUnits.id, job.unitId),
      ),
    });
    if (!selectedUnit) return null;
    units = [selectedUnit];
  } else {
    units = await db.query.reviewUnits.findMany({
      where: eq(reviewUnits.snapshotId, snapshot.id),
      orderBy: [reviewUnits.path, reviewUnits.startLine],
    });
  }
  return { job, units };
}

/** Handles a read request from an isolated AI job runtime. */
export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ jobId: string; path: string[] }>;
  },
) {
  if (!authorized(request)) return new NextResponse(null, { status: 404 });
  const { jobId, path } = await params;
  if (path[0] === "proxy") {
    return proxyModelRequest(request, jobId, path);
  }
  if (path[0] === "config") {
    const configuration = await getAiJobConfiguration(db, jobId);
    if (!configuration) return new NextResponse(null, { status: 404 });
    return NextResponse.json(
      configuration.useManagedModels
        ? configuration
        : {
            ...configuration,
            apiKey: "reviewduck-proxy",
            headers: { "x-reviewduck-internal": env.FLUE_INTERNAL_SECRET },
            baseUrl: `${request.nextUrl.origin}/api/internal/ai/jobs/${jobId}/proxy`,
          },
    );
  }
  const context = await contextUnits(jobId);
  if (!context) return new NextResponse(null, { status: 404 });
  if (path.length === 1 && path[0] === "files") {
    const files = new Map<string, { symbols: string[]; changeType: string }>();
    for (const unit of context.units) {
      const current = files.get(unit.path);
      files.set(unit.path, {
        symbols: [...(current?.symbols ?? []), unit.name],
        changeType: unit.changeType,
      });
    }
    return NextResponse.json(
      [...files].map(([filePath, details]) => ({
        path: filePath,
        ...details,
      })),
    );
  }
  if (path[0] === "files" && path.length > 1) {
    const requestedPath = path.slice(1).join("/");
    const matching = context.units.filter(
      (unit) => unit.path === requestedPath,
    );
    if (matching.length === 0) {
      return new NextResponse(null, { status: 404 });
    }
    const moduleUnit =
      matching.find((unit) => unit.kind === "file") ??
      matching.find((unit) => unit.kind === "module");
    return NextResponse.json({
      path: requestedPath,
      changeType: matching[0]?.changeType ?? "modified",
      previousContent: moduleUnit?.previousSource ?? undefined,
      content:
        moduleUnit?.source ??
        matching
          .map(
            (unit) =>
              `// ${unit.kind} ${unit.name}, original lines ${unit.startLine}-${unit.endLine}\n${unit.source}`,
          )
          .join("\n\n"),
    });
  }
  return new NextResponse(null, { status: 404 });
}

/** Handles a write request from an isolated AI job runtime. */
export async function POST(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ jobId: string; path: string[] }>;
  },
) {
  if (!authorized(request)) return new NextResponse(null, { status: 404 });
  const { jobId, path } = await params;
  if (path[0] === "proxy") {
    return proxyModelRequest(request, jobId, path);
  }
  if (path.length !== 1 || path[0] !== "result") {
    return new NextResponse(null, { status: 404 });
  }
  const result = aiResultSchema.safeParse(await request.json());
  if (!result.success) {
    return NextResponse.json(
      { error: result.error.flatten() },
      { status: 400 },
    );
  }
  const context = await contextUnits(jobId);
  if (!context) return new NextResponse(null, { status: 404 });
  const invalidAnnotation = result.data.annotations.some((annotation) => {
    const endLine = annotation.endLine ?? annotation.line;
    return (
      endLine < annotation.line ||
      !context.units.some(
        (unit) =>
          unit.path === annotation.path &&
          annotation.line >= unit.startLine &&
          endLine <= unit.endLine,
      )
    );
  });
  const explanationUnit =
    context.job.kind === "explain" ? context.units[0] : undefined;
  const explanationRanges = explanationUnit
    ? explanationChangedLineRanges(explanationUnit)
    : [];
  const constrainedResult =
    context.job.kind === "explain" && explanationUnit
      ? {
          ...result.data,
          annotations: result.data.annotations.flatMap((annotation) => {
            if (annotation.path !== explanationUnit.path) return [];
            const constrained = constrainAnnotationToChangedLines(
              annotation,
              explanationRanges,
            );
            return constrained ? [constrained] : [];
          }),
        }
      : result.data;
  if (
    context.job.kind === "explain" &&
    (result.data.findings.length > 0 ||
      (result.data.annotations.length > 0 && invalidAnnotation))
  ) {
    return NextResponse.json(
      {
        error:
          "Explanations require valid unit-scoped annotations and no review findings",
      },
      { status: 400 },
    );
  }
  if (
    context.job.kind === "review" &&
    (result.data.annotations.length > 0 ||
      result.data.findings.some(
        (finding) =>
          !finding.path ||
          finding.line === undefined ||
          !context.units.some(
            (unit) =>
              unit.path === finding.path &&
              finding.line !== undefined &&
              finding.line >= unit.startLine &&
              finding.line <= unit.endLine,
          ),
      ))
  ) {
    return NextResponse.json(
      {
        error:
          "Reviews require valid line-addressable findings and no explanatory annotations",
      },
      { status: 400 },
    );
  }
  const accepted = await acceptAiJobResult(db, jobId, constrainedResult);
  return accepted
    ? NextResponse.json({ accepted: true })
    : NextResponse.json({ accepted: false }, { status: 409 });
}
