import { buildProviderLifecycle } from "~/lib/provider-lifecycle";
import {
  type AzurePolicyEvaluationGate,
  azureMergeGate,
  azurePolicyCheckState,
} from "~/lib/provider-merge-gate";
import { isLikelyBinaryFile } from "~/server/analysis/types";
import {
  optionalProviderFetch,
  providerFetch,
  providerResponse,
  providerText,
  providerVoid,
} from "./http";
import { collectProviderSourceFiles } from "./source-budget";
import type {
  ChangedFilesOptions,
  ProviderCheckState,
  ProviderPullRequestCheck,
  ProviderPullRequestLifecycle,
  ProviderPullRequestReviewState,
  ProviderReviewAction,
  PullRequestListOptions,
  PullRequestProvider,
  PullRequestSummary,
  RepositoryBranch,
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
  mergeStatus?: string;
  repository: {
    id?: string;
    name?: string;
    webUrl?: string;
    project?: { id?: string; name?: string };
  };
  _links?: { web?: { href?: string } };
  createdBy: {
    id: string;
    displayName: string;
    uniqueName?: string;
    imageUrl?: string;
  };
}
interface AzurePullStatus {
  id: number;
  state: string;
  description?: string;
  creationDate?: string;
  targetUrl?: string;
  context?: { name?: string; genre?: string };
}
interface AzurePolicyEvaluation {
  evaluationId?: string;
  status?: string;
  configuration?: {
    id?: string;
    isEnabled?: boolean;
    isBlocking?: boolean;
    isDeleted?: boolean;
    type?: { displayName?: string };
    settings?: { displayName?: string; statusName?: string };
  };
}
interface AzureReviewer {
  id: string;
  displayName?: string;
  uniqueName?: string;
  vote: number;
}
interface AzureChange {
  item?: {
    path?: string | null;
    objectId?: string;
    gitObjectType?: string;
  };
  changeType: string;
  sourceServerItem?: string;
}
interface AzureItem {
  path: string;
  gitObjectType?: "blob" | "tree";
  isFolder?: boolean;
}
interface AzureRef {
  name: string;
  objectId: string;
}
interface AzureHookSubscription {
  id: string;
  status?: string;
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
  ) {
    this.headers = {
      Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
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
  /** Lists every branch visible through the configured Azure credential. */
  async listBranches(
    repositoryExternalId: string,
  ): Promise<RepositoryBranch[]> {
    const [repository, refs] = await Promise.all([
      providerFetch<AzureRepository>(
        this.name,
        `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}?api-version=7.1`,
        { headers: this.headers },
      ),
      this.getAllPages<AzureRef>(
        `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/refs?filter=heads/&api-version=7.1`,
      ),
    ]);
    const defaultBranch = repository.defaultBranch?.replace("refs/heads/", "");
    return refs.map((ref) => {
      const name = ref.name.replace("refs/heads/", "");
      const webUrl = new URL(repository.webUrl);
      webUrl.searchParams.set("version", `GB${name}`);
      return {
        name,
        sha: ref.objectId,
        webUrl: webUrl.toString(),
        isDefault: name === defaultBranch,
      };
    });
  }

  /** Resolves one Azure branch and rejects arbitrary refs. */
  async getBranch(
    repositoryExternalId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<RepositoryBranch> {
    const [repository, refs] = await Promise.all([
      providerFetch<AzureRepository>(
        this.name,
        `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}?api-version=7.1`,
        { headers: this.headers, signal },
      ),
      providerFetch<{ value: AzureRef[] }>(
        this.name,
        `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/refs?filter=${encodeURIComponent(`heads/${branch}`)}&api-version=7.1`,
        { headers: this.headers, signal },
      ),
    ]);
    const exactName = `refs/heads/${branch}`;
    const resolved = refs.value.find((ref) => ref.name === exactName);
    if (!resolved) throw new Error(`Branch ${branch} was not found`);
    const webUrl = new URL(repository.webUrl);
    webUrl.searchParams.set("version", `GB${branch}`);
    return {
      name: branch,
      sha: resolved.objectId,
      webUrl: webUrl.toString(),
      isDefault: repository.defaultBranch === exactName,
    };
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
    const matching = new Map(
      existing.value
        .filter(
          (hook) =>
            hook.consumerInputs?.url === input.callbackUrl &&
            hook.publisherInputs?.repository === input.repositoryExternalId &&
            (hook.status === undefined ||
              hook.status === "enabled" ||
              hook.status === "onProbation"),
        )
        .map((hook) => [hook.eventType, hook.id]),
    );
    const hookIds: string[] = [];
    for (const eventType of AZURE_PULL_REQUEST_EVENTS) {
      const existingId = matching.get(eventType);
      if (existingId) {
        hookIds.push(existingId);
        continue;
      }
      const created = await providerFetch<AzureHookSubscription>(
        this.name,
        endpoint,
        {
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
        },
      );
      hookIds.push(created.id);
    }
    return hookIds;
  }
  /** Removes this application's Azure service-hook subscriptions. */
  async removeRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
    remoteHookIds: string[];
  }) {
    const endpoint = `${this.organizationUrl}/_apis/hooks/subscriptions`;
    await Promise.all(
      input.remoteHookIds.map((hookId) =>
        providerVoid(
          this.name,
          `${endpoint}/${encodeURIComponent(hookId)}?api-version=7.1`,
          { method: "DELETE", headers: this.headers },
          [404],
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
  /** Fetches Azure DevOps PR statuses and mergeability. */
  async getPullRequestLifecycle(
    repositoryExternalId: string,
    number: number,
  ): Promise<ProviderPullRequestLifecycle> {
    const endpoint = `${this.organizationUrl}/_apis/git/repositories/${repositoryExternalId}/pullRequests/${number}`;
    const pull = await providerFetch<AzurePull>(
      this.name,
      `${endpoint}?api-version=7.1`,
      { headers: this.headers },
    );
    const [statuses, evaluations] = await Promise.all([
      optionalProviderFetch<{ value: AzurePullStatus[] }>(
        this.name,
        `${endpoint}/statuses?api-version=7.1`,
        { headers: this.headers },
      ),
      this.policyEvaluations(pull, number),
    ]);
    const policies = this.normalizePolicies(evaluations);
    const merge = azureMergeGate({
      status: pull.status,
      isDraft: pull.isDraft,
      mergeStatus: pull.mergeStatus,
      policies,
    });
    return buildProviderLifecycle({
      checks: [
        ...this.normalizeStatuses(
          statuses?.value ?? [],
          policies.some(
            (policy) => policy.enabled !== false && !policy.deleted,
          ),
        ),
        ...this.policyChecks(evaluations),
      ],
      pullRequestState:
        pull.status === "completed"
          ? "merged"
          : pull.status === "abandoned"
            ? "closed"
            : pull.isDraft
              ? "draft"
              : "open",
      headSha: pull.lastMergeSourceCommit.commitId,
      mergeable: merge.mergeable,
      canMerge: merge.canMerge,
      mergeBlockedReason: merge.mergeBlockedReason,
      mergeActionLabel: "Complete",
    });
  }

  /** Completes the pull request at the exact reviewed Azure commit. */
  async mergePullRequest(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
  }) {
    await providerFetch<AzurePull>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}?api-version=7.1`,
      {
        method: "PATCH",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "completed",
          lastMergeSourceCommit: { commitId: input.headSha },
          completionOptions: {
            mergeStrategy: "noFastForward",
            deleteSourceBranch: false,
          },
        }),
      },
    );
  }

  /** Fetches the changed source files required for static analysis. */
  async getChangedFiles(
    repositoryExternalId: string,
    number: number,
    options?: ChangedFilesOptions,
  ) {
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
    const sourceChanges = changes.filter(
      (change): change is AzureChange & { item: { path: string } } =>
        typeof change.item?.path === "string" &&
        change.item.path.length > 0 &&
        change.item.gitObjectType !== "tree",
    );
    return collectProviderSourceFiles(
      sourceChanges,
      options?.maximumSourceBytes,
      async (change) => {
        const normalizedChangeType = change.changeType.toLowerCase();
        const deleted = normalizedChangeType.includes("delete");
        const added = normalizedChangeType.includes("add");
        const ref = deleted ? pull.baseSha : pull.headSha;
        const path = change.item.path.replace(/^\//, "");
        const knownBinary = isLikelyBinaryFile(path);
        const changeType = deleted
          ? ("deleted" as const)
          : added
            ? ("added" as const)
            : normalizedChangeType.includes("rename")
              ? ("renamed" as const)
              : ("modified" as const);
        const skippedFile = {
          path,
          content: "",
          skipReason: "too_large" as const,
          isBinary: false,
          binaryHash: change.item.objectId ?? `${ref}:${path}`,
          changeType,
        };
        if (knownBinary) {
          return {
            file: {
              path,
              content: "",
              isBinary: true,
              binaryHash: change.item.objectId ?? `${ref}:${path}`,
              changeType,
            },
          };
        }
        const content = await this.getFileContent(
          repositoryExternalId,
          change.item.path,
          ref,
        );
        if (content === undefined) {
          return { file: skippedFile };
        }
        if (isLikelyBinaryFile(path, content)) {
          return {
            file: {
              path,
              content: "",
              isBinary: true,
              binaryHash:
                change.item.objectId ?? `${ref}:${path}:${content.length}`,
              changeType,
            },
          };
        }
        const previousContent =
          !added && !deleted
            ? await this.getFileContent(
                repositoryExternalId,
                change.sourceServerItem ?? change.item.path,
                pull.baseSha,
              )
            : undefined;
        if (!added && !deleted && previousContent === undefined) {
          return { file: skippedFile };
        }
        return {
          file: {
            path,
            content,
            previousContent,
            isBinary: false,
            changeType,
          },
          oversizedHash: change.item.objectId ?? `${ref}:${path}`,
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
    idempotencyKey: string;
  }) {
    const thread = await providerFetch<AzureThread>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/threads?api-version=7.1`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
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

  /**
   * Closes or reopens one Azure DevOps pull-request thread.
   *
   * Azure models resolution as a thread status rather than a flag, and its
   * "fixed" status is the one its pull-request interface shows as Resolved;
   * "closed" is a separate outcome there.
   */
  async setInlineThreadResolution(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    resolved: boolean;
  }) {
    await providerFetch<AzureThread>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/threads/${encodeURIComponent(input.threadExternalId)}?api-version=7.1`,
      {
        method: "PATCH",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ status: input.resolved ? "fixed" : "active" }),
      },
    );
  }

  /** Rewrites one comment of an Azure DevOps pull-request thread. */
  async editInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    commentExternalId: string;
    body: string;
  }) {
    await providerFetch<AzureThreadComment>(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/threads/${encodeURIComponent(input.threadExternalId)}/comments/${encodeURIComponent(input.commentExternalId)}?api-version=7.1`,
      {
        method: "PATCH",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ content: input.body }),
      },
    );
  }

  /** Deletes one comment of an Azure DevOps pull-request thread. */
  async deleteInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    commentExternalId: string;
  }) {
    await providerVoid(
      this.name,
      `${this.organizationUrl}/_apis/git/repositories/${input.repositoryExternalId}/pullRequests/${input.pullRequestNumber}/threads/${encodeURIComponent(input.threadExternalId)}/comments/${encodeURIComponent(input.commentExternalId)}?api-version=7.1`,
      { method: "DELETE", headers: this.headers },
      // A conversation is deleted one comment at a time, so a retry of a
      // partial delete re-requests comments that already left. Their absence
      // is the outcome the caller wanted, not a failure to report.
      [404],
    );
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
  /** Reads blocking Azure branch-policy evaluations for this pull request. */
  private async policyEvaluations(pull: AzurePull, number: number) {
    const projectId = pull.repository.project?.id;
    const projectName = pull.repository.project?.name;
    if (!projectId || !projectName) return [];
    const artifactId = `vstfs:///CodeReview/PullRequestId/${projectId}/${number}`;
    const response = await optionalProviderFetch<{
      value: AzurePolicyEvaluation[];
    }>(
      this.name,
      `${this.organizationUrl}/${encodeURIComponent(projectName)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&api-version=7.1-preview.1`,
      { headers: this.headers },
    );
    return response?.value ?? [];
  }

  /** Maps Azure policy evaluations onto the shared merge-gate model. */
  private normalizePolicies(
    evaluations: AzurePolicyEvaluation[],
  ): AzurePolicyEvaluationGate[] {
    return evaluations.map((evaluation) => ({
      enabled: evaluation.configuration?.isEnabled,
      blocking: evaluation.configuration?.isBlocking,
      deleted: evaluation.configuration?.isDeleted,
      status: evaluation.status,
      name:
        evaluation.configuration?.type?.displayName ??
        evaluation.configuration?.settings?.displayName ??
        evaluation.configuration?.settings?.statusName,
    }));
  }

  /** Surfaces enabled policy evaluations as checks on the completion page. */
  private policyChecks(
    evaluations: AzurePolicyEvaluation[],
  ): ProviderPullRequestCheck[] {
    return evaluations.flatMap((evaluation) => {
      const configuration = evaluation.configuration;
      if (
        !configuration ||
        configuration.isDeleted ||
        !configuration.isEnabled
      ) {
        return [];
      }
      const name =
        configuration.type?.displayName?.trim() ||
        configuration.settings?.displayName?.trim() ||
        configuration.settings?.statusName?.trim() ||
        "Policy";
      return [
        {
          id: `policy-${configuration.id ?? evaluation.evaluationId ?? name}`,
          name,
          state: azurePolicyCheckState(evaluation.status ?? ""),
          required: Boolean(configuration.isBlocking),
        },
      ];
    });
  }

  /** Keeps the newest status for each Azure policy or check context. */
  private normalizeStatuses(
    statuses: AzurePullStatus[],
    statusesAreOptional = false,
  ): ProviderPullRequestCheck[] {
    const latestByName = new Map<string, AzurePullStatus>();
    for (const status of statuses) {
      const genre = status.context?.genre?.trim();
      const name = status.context?.name?.trim();
      const key = name
        ? genre
          ? `${genre}/${name}`
          : name
        : String(status.id);
      const existing = latestByName.get(key);
      if (
        !existing ||
        (status.creationDate ?? "") > (existing.creationDate ?? "")
      ) {
        latestByName.set(key, status);
      }
    }
    return [...latestByName.values()].map((status) => ({
      id: `status-${status.id}`,
      name: status.context?.name?.trim() || `Status ${status.id}`,
      state: this.statusState(status.state),
      description: status.description?.trim() || undefined,
      webUrl: status.targetUrl,
      required: statusesAreOptional ? false : undefined,
    }));
  }

  /** Maps an Azure PR status onto the shared check model. */
  private statusState(state: string): ProviderCheckState {
    if (state === "succeeded") return "success";
    if (state === "failed" || state === "error") return "failure";
    if (state === "pending") return "in_progress";
    return "neutral";
  }

  /** Converts a provider-specific pull request into ReviewDuck's normalized model. */
  private normalize(item: AzurePull): PullRequestSummary {
    const projectName = item.repository.project?.name;
    const repositoryName = item.repository.name;
    const repositoryWebUrl =
      item.repository.webUrl ??
      (projectName && repositoryName
        ? `${this.organizationUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repositoryName)}`
        : `${this.organizationUrl}/_git/${encodeURIComponent(item.repository.id ?? repositoryName ?? "repository")}`);
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
      webUrl:
        item._links?.web?.href ??
        `${repositoryWebUrl}/pullrequest/${item.pullRequestId}`,
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
