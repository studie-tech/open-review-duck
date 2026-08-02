import { isLikelyBinaryFile } from "~/server/analysis/types";
import {
  mapWithConcurrency,
  providerFetch,
  providerResponse,
  providerText,
  providerVoid,
} from "./http";
import type {
  ProviderPullRequestReviewState,
  ProviderReviewAction,
  PullRequestListOptions,
  PullRequestProvider,
  PullRequestSummary,
  RepositoryIdentity,
} from "./types";

interface AzureRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl: string;
  project: { name: string };
}
interface AzureConnectionData {
  authenticatedUser: { id: string; providerDisplayName?: string };
}
interface AzurePull {
  pullRequestId: number;
  title: string;
  description?: string;
  status: "active" | "completed" | "abandoned";
  isDraft: boolean;
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit: { commitId: string };
  lastMergeTargetCommit: { commitId: string };
  repository: { webUrl: string };
  createdBy: {
    id: string;
    displayName: string;
    uniqueName?: string;
    imageUrl?: string;
  };
}
interface AzureReviewer {
  id: string;
  displayName?: string;
  uniqueName?: string;
  vote: number;
}
interface AzureChange {
  item: { path: string; objectId?: string; gitObjectType?: string };
  changeType: string;
  sourceServerItem?: string;
}
interface AzureItem {
  path: string;
  gitObjectType?: "blob" | "tree";
  isFolder?: boolean;
}
interface AzureHookSubscription {
  id: string;
  eventType: string;
  consumerInputs?: { url?: string };
  publisherInputs?: { repository?: string };
}
interface AzureThread {
  id: number;
  status?: number | string;
  isDeleted?: boolean;
  threadContext?: {
    filePath?: string;
    leftFileStart?: { line: number };
    rightFileStart?: { line: number };
  };
  comments?: AzureThreadComment[];
}
interface AzureThreadComment {
  id: number;
  content?: string;
  isDeleted?: boolean;
  commentType?: number | string;
  publishedDate: string;
  author: {
    displayName: string;
    uniqueName?: string;
    imageUrl?: string;
  };
}
const MAX_PROVIDER_PAGES = 100;
const MAX_PROVIDER_ITEMS = 20_000;
const AZURE_PULL_REQUEST_EVENTS = [
  "git.pullrequest.created",
  "git.pullrequest.updated",
  "git.pullrequest.merged",
] as const;

export class AzureDevOpsProvider implements PullRequestProvider {
  readonly name = "azure_devops" as const;
  private readonly headers: HeadersInit;
  /** Initializes an authenticated provider client. */
  constructor(
    token: string,
    private readonly organizationUrl: string,
    oauth = false,
  ) {
    this.headers = {
      Authorization: oauth
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
    };
  }
  /** Fetches the account identity associated with a provider token. */
  async getConnectionIdentity() {
    const data = await providerFetch<AzureConnectionData>(
      this.name,
      `${this.organizationUrl}/_apis/connectionData?api-version=7.1-preview.1`,
      { headers: this.headers },
    );
    return {
      externalAccountId: data.authenticatedUser.id,
      displayName:
        data.authenticatedUser.providerDisplayName ?? data.authenticatedUser.id,
    };
  }
  /** Lists every repository accessible through the provider connection. */
  async listRepositories(): Promise<RepositoryIdentity[]> {
    const repositories = await this.getAllPages<AzureRepository>(
      `${this.organizationUrl}/_apis/git/repositories?api-version=7.1`,
    );
    return repositories.map((repo) => ({
      externalId: repo.id,
      owner: repo.project.name,
      name: repo.name,
      defaultBranch: repo.defaultBranch?.replace("refs/heads/", "") ?? "main",
      webUrl: repo.webUrl,
      isPrivate: true,
    }));
  }
  /** Creates the Azure service-hook subscriptions required for PR lifecycle events. */
  async ensureRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
    secret: string;
  }) {
    const endpoint = `${this.organizationUrl}/_apis/hooks/subscriptions?api-version=7.1`;
    const existing = await providerFetch<{ value: AzureHookSubscription[] }>(
      this.name,
      endpoint,
      { headers: this.headers },
    );
    const matching = new Set(
      existing.value
        .filter(
          (hook) =>
            hook.consumerInputs?.url === input.callbackUrl &&
            hook.publisherInputs?.repository === input.repositoryExternalId,
        )
        .map((hook) => hook.eventType),
    );
    for (const eventType of AZURE_PULL_REQUEST_EVENTS) {
      if (matching.has(eventType)) continue;
      await providerFetch<AzureHookSubscription>(this.name, endpoint, {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          publisherId: "tfs",
          eventType,
          resourceVersion: "1.0",
          consumerId: "webHooks",
          consumerActionId: "httpRequest",
          publisherInputs: { repository: input.repositoryExternalId },
          consumerInputs: {
            url: input.callbackUrl,
            basicAuthUsername: "reviewduck",
            basicAuthPassword: input.secret,
          },
        }),
      });
    }
  }
  /** Removes this application's Azure service-hook subscriptions. */
  async removeRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
  }) {
    const endpoint = `${this.organizationUrl}/_apis/hooks/subscriptions`;
    const existing = await providerFetch<{ value: AzureHookSubscription[] }>(
      this.name,
      `${endpoint}?api-version=7.1`,
      { headers: this.headers },
    );
    await Promise.all(
      existing.value
        .filter(
          (hook) =>
            hook.consumerInputs?.url === input.callbackUrl &&
            hook.publisherInputs?.repository === input.repositoryExternalId,
        )
        .map((hook) =>
          providerVoid(
            this.name,
            `${endpoint}/${encodeURIComponent(hook.id)}?api-version=7.1`,
            { method: "DELETE", headers: this.headers },
          ),
        ),
    );
  }
  /** Lists open pull requests for a provider repository. */
  async listOpenPullRequests(
    repositoryExternalId: string,
    options: PullRequestListOptions = {},
  ) {
    const reviewer = options.reviewerExternalAccountId
      ? `&searchCriteria.reviewerId=${encodeURIComponent(options.reviewerExternalAccountId)}`
      : "";
    const pulls = await this.getAllPages<AzurePull>(
      `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullrequests?searchCriteria.status=active${reviewer}&api-version=7.1`,
    );
    return pulls.map((item) => this.normalize(item));
  }
  /** Fetches normalized metadata for one pull request. */
  async getPullRequest(repositoryExternalId: string, number: number) {
    return this.normalize(
      await providerFetch<AzurePull>(
        this.name,
        `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullrequests/${number}?api-version=7.1`,
        { headers: this.headers },
      ),
    );
  }
  /** Fetches the connected Azure DevOps user's current reviewer vote. */
  async getPullRequestReviewState(
    repositoryExternalId: string,
    number: number,
  ): Promise<ProviderPullRequestReviewState> {
    const endpoint = `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullRequests/${number}`;
    const [connection, reviewers, pull] = await Promise.all([
      providerFetch<AzureConnectionData>(
        this.name,
        `${this.organizationUrl}/_apis/connectionData?api-version=7.1-preview.1`,
        { headers: this.headers },
      ),
      providerFetch<{ value: AzureReviewer[] }>(
        this.name,
        `${endpoint}/reviewers?api-version=7.1`,
        { headers: this.headers },
      ),
      providerFetch<AzurePull>(this.name, `${endpoint}?api-version=7.1`, {
        headers: this.headers,
      }),
    ]);
    const actor = connection.authenticatedUser;
    const reviewer = reviewers.value.find((item) => item.id === actor.id);
    const vote = reviewer?.vote ?? 0;
    const unavailableReason =
      pull.status !== "active"
        ? "This pull request is no longer active."
        : undefined;
    return {
      decision:
        vote === 10 || vote === 5
          ? "approved"
          : vote === -10
            ? "changes_requested"
            : vote === -5
              ? "waiting"
              : "none",
      actorName: actor.providerDisplayName ?? actor.id,
      approvedCount: reviewers.value.filter(
        (item) => item.vote === 10 || item.vote === 5,
      ).length,
      changesRequestedCount: reviewers.value.filter((item) => item.vote === -10)
        .length,
      canApprove: !unavailableReason && vote !== 10,
      canRequestChanges: !unavailableReason && vote !== -10,
      canClear: !unavailableReason && vote !== 0,
      requestChangesRequiresBody: false,
      unavailableReason,
    };
  }
  /** Sets the connected Azure DevOps reviewer's exact live vote. */
  async setPullRequestReviewDecision(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
    action: ProviderReviewAction;
    body?: string;
  }) {
    const identity = await this.getConnectionIdentity();
    await providerVoid(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/reviewers/${encodeURIComponent(identity.externalAccountId)}?api-version=7.1`,
      {
        method: "PUT",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: identity.externalAccountId,
          vote:
            input.action === "approve"
              ? 10
              : input.action === "request_changes"
                ? -10
                : 0,
        }),
      },
    );
  }
  /** Fetches the changed source files required for static analysis. */
  async getChangedFiles(repositoryExternalId: string, number: number) {
    const iterations = await providerFetch<{ value: Array<{ id: number }> }>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullrequests/${number}/iterations?api-version=7.1`,
      { headers: this.headers },
    );
    const latest = iterations.value.at(-1);
    if (!latest) return [];
    const changes = await this.getAllChanges(
      `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullrequests/${number}/iterations/${latest.id}/changes?api-version=7.1`,
    );
    const pull = await this.getPullRequest(repositoryExternalId, number);
    return mapWithConcurrency(
      changes.filter((change) => change.item.gitObjectType !== "tree"),
      8,
      async (change) => {
        const normalizedChangeType = change.changeType.toLowerCase();
        const deleted = normalizedChangeType.includes("delete");
        const added = normalizedChangeType.includes("add");
        const ref = deleted ? pull.baseSha : pull.headSha;
        const path = change.item.path.replace(/^\//, "");
        const knownBinary = isLikelyBinaryFile(path);
        const [content, previousContent] = !knownBinary
          ? await Promise.all([
              this.getFileContent(repositoryExternalId, change.item.path, ref),
              !added && !deleted
                ? this.getFileContent(
                    repositoryExternalId,
                    change.sourceServerItem ?? change.item.path,
                    pull.baseSha,
                  )
                : undefined,
            ])
          : ["", undefined];
        const isBinary = knownBinary || isLikelyBinaryFile(path, content);
        return {
          path,
          content: isBinary ? "" : (content ?? ""),
          previousContent: isBinary ? undefined : previousContent,
          skipReason:
            !knownBinary && content === undefined
              ? ("too_large" as const)
              : undefined,
          isBinary,
          binaryHash:
            isBinary || content === undefined
              ? (change.item.objectId ?? `${ref}:${path}:${content ?? ""}`)
              : undefined,
          changeType: deleted
            ? ("deleted" as const)
            : added
              ? ("added" as const)
              : normalizedChangeType.includes("rename")
                ? ("renamed" as const)
                : ("modified" as const),
        };
      },
    );
  }

  /** Lists regular files from one exact Git commit tree. */
  async listRepositoryFiles(repositoryExternalId: string, ref: string) {
    const items = await this.getAllPages<AzureItem>(
      `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/items?scopePath=%2F&recursionLevel=Full&includeContentMetadata=false&versionDescriptor.versionType=commit&versionDescriptor.version=${encodeURIComponent(ref)}&api-version=7.1`,
    );
    return items
      .filter((item) => !item.isFolder && item.gitObjectType !== "tree")
      .map((item) => item.path.replace(/^\/+/, ""))
      .filter(Boolean);
  }
  /** Publishes an inline review comment to the code provider. */
  async publishInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
    path: string;
    line: number;
    side: "left" | "right";
    body: string;
  }) {
    const thread = await providerFetch<AzureThread>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/threads?api-version=7.1`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comments: [
            { parentCommentId: 0, content: input.body, commentType: 1 },
          ],
          status: 1,
          threadContext: {
            filePath: `/${input.path.replace(/^\/+/, "")}`,
            ...(input.side === "left"
              ? {
                  leftFileStart: { line: input.line, offset: 1 },
                  leftFileEnd: { line: input.line, offset: 1 },
                }
              : {
                  rightFileStart: { line: input.line, offset: 1 },
                  rightFileEnd: { line: input.line, offset: 1 },
                }),
          },
        }),
      },
    );
    return { externalId: String(thread.id) };
  }

  /** Publishes a reply inside an existing Azure DevOps pull-request thread. */
  async replyToInlineThread(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    parentCommentExternalId: string;
    body: string;
  }) {
    const comment = await providerFetch<AzureThreadComment>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/threads/${encodeURIComponent(input.threadExternalId)}/comments?api-version=7.1`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: input.body,
          parentCommentId: Number(input.parentCommentExternalId),
          commentType: 1,
        }),
      },
    );
    return { externalId: String(comment.id) };
  }

  /** Lists and normalizes inline review conversations from the provider. */
  async listInlineCommentThreads(
    repositoryExternalId: string,
    pullRequestNumber: number,
  ) {
    const response = await providerFetch<{ value: AzureThread[] }>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullRequests/${pullRequestNumber}/threads?api-version=7.1`,
      { headers: this.headers },
    );
    return response.value.flatMap((thread) => {
      const context = thread.threadContext;
      const path = context?.filePath?.replace(/^\/+/, "");
      const line =
        context?.rightFileStart?.line ?? context?.leftFileStart?.line;
      if (thread.isDeleted || !path || !line) return [];
      const comments = (thread.comments ?? []).filter(
        (comment) =>
          !comment.isDeleted &&
          comment.content &&
          comment.commentType !== "system" &&
          comment.commentType !== 3,
      );
      if (comments.length === 0) return [];
      const status =
        thread.status === "active" || thread.status === 1
          ? ("open" as const)
          : thread.status === undefined || thread.status === "unknown"
            ? ("unknown" as const)
            : ("resolved" as const);
      return [
        {
          externalId: String(thread.id),
          path,
          line,
          side: context?.rightFileStart
            ? ("right" as const)
            : ("left" as const),
          status,
          comments: comments.map((comment) => ({
            externalId: String(comment.id),
            body: comment.content ?? "",
            author:
              comment.author.displayName ||
              comment.author.uniqueName ||
              "Unknown",
            authorAvatarUrl: comment.author.imageUrl,
            createdAt: comment.publishedDate,
          })),
        },
      ];
    });
  }
  /** Fetches file content at a provider revision within the configured size limit. */
  getFileContent(
    repositoryExternalId: string,
    path: string,
    ref: string,
    maximumBytes?: number,
  ) {
    return providerText(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/items?path=${encodeURIComponent(path)}&versionDescriptor.versionType=commit&versionDescriptor.version=${ref}&download=true&api-version=7.1`,
      {
        headers: {
          ...this.headers,
          Accept: "application/octet-stream",
        },
      },
      maximumBytes,
    );
  }
  /** Converts a provider-specific pull request into ReviewDuck's normalized model. */
  private normalize(item: AzurePull): PullRequestSummary {
    return {
      externalId: String(item.pullRequestId),
      number: item.pullRequestId,
      title: item.title,
      description: item.description,
      authorLogin: item.createdBy.uniqueName ?? item.createdBy.displayName,
      authorAvatarUrl: item.createdBy.imageUrl,
      sourceBranch: item.sourceRefName.replace("refs/heads/", ""),
      targetBranch: item.targetRefName.replace("refs/heads/", ""),
      headSha: item.lastMergeSourceCommit.commitId,
      baseSha: item.lastMergeTargetCommit.commitId,
      state:
        item.status === "active"
          ? item.isDraft
            ? "draft"
            : "open"
          : item.status === "completed"
            ? "merged"
            : "closed",
      webUrl: `${item.repository.webUrl}/pullrequest/${item.pullRequestId}`,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    };
  }

  /** Fetches every page of a paginated provider endpoint. */
  private async getAllPages<T>(initialUrl: string): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const cursor = continuationToken ?? "first";
      if (visited.size >= MAX_PROVIDER_PAGES || visited.has(cursor)) {
        throw new Error("Azure DevOps pagination exceeded its safety limit");
      }
      visited.add(cursor);
      const url = new URL(initialUrl);
      url.searchParams.set("$top", "100");
      if (continuationToken)
        url.searchParams.set("continuationToken", continuationToken);
      const response = await providerResponse<{ value: T[] }>(
        this.name,
        url.toString(),
        { headers: this.headers },
      );
      items.push(...response.data.value);
      if (items.length > MAX_PROVIDER_ITEMS) {
        throw new Error("Azure DevOps pagination exceeded its item limit");
      }
      continuationToken =
        response.headers.get("x-ms-continuationtoken") ?? undefined;
    } while (continuationToken);
    return items;
  }

  /** Fetches every page of Azure DevOps pull-request changes. */
  private async getAllChanges(initialUrl: string): Promise<AzureChange[]> {
    const items: AzureChange[] = [];
    const visited = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const cursor = continuationToken ?? "first";
      if (visited.size >= MAX_PROVIDER_PAGES || visited.has(cursor)) {
        throw new Error("Azure DevOps pagination exceeded its safety limit");
      }
      visited.add(cursor);
      const url = new URL(initialUrl);
      url.searchParams.set("$top", "2000");
      if (continuationToken)
        url.searchParams.set("continuationToken", continuationToken);
      const response = await providerResponse<{
        changeEntries: AzureChange[];
      }>(this.name, url.toString(), { headers: this.headers });
      items.push(...response.data.changeEntries);
      if (items.length > MAX_PROVIDER_ITEMS) {
        throw new Error("Azure DevOps pagination exceeded its item limit");
      }
      continuationToken =
        response.headers.get("x-ms-continuationtoken") ?? undefined;
    } while (continuationToken);
    return items;
  }
}
