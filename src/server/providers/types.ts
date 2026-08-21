import type { SourceFile } from "~/server/analysis/types";

export type ProviderName = "github" | "gitlab" | "azure_devops";

export interface RepositoryIdentity {
  externalId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  webUrl: string;
  isPrivate: boolean;
}

export interface RepositoryBranch {
  name: string;
  sha: string;
  webUrl: string;
  isDefault: boolean;
}

export interface PullRequestSummary {
  externalId: string;
  number: number;
  title: string;
  description?: string;
  authorLogin: string;
  authorAvatarUrl?: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  baseSha: string;
  state: "open" | "merged" | "closed" | "draft";
  webUrl: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PullRequestListOptions {
  /**
   * Restricts results to pull requests assigned to the connected reviewer.
   *
   * Providers interpret assignment using their native review model: requested
   * reviewer or assignee on GitHub, reviewer on GitLab, and reviewer on Azure.
   */
  reviewerExternalAccountId?: string;
}

export interface ChangedFilesOptions {
  /** Maximum combined UTF-8 bytes retained across current and previous source. */
  maximumSourceBytes?: number;
}

interface ProviderReviewComment {
  externalId: string;
  body: string;
  author: string;
  authorAvatarUrl?: string;
  createdAt: string;
  webUrl?: string;
}

export interface ProviderReviewThread {
  externalId: string;
  path: string;
  line: number;
  side: "left" | "right";
  status: "open" | "resolved" | "unknown";
  webUrl?: string;
  comments: ProviderReviewComment[];
}

type ProviderReviewDecision =
  | "approved"
  | "changes_requested"
  | "waiting"
  | "none";

export type ProviderReviewAction = "approve" | "request_changes" | "clear";

/** Normalized, live provider review state for the connected reviewer. */
export interface ProviderPullRequestReviewState {
  decision: ProviderReviewDecision;
  actorName: string;
  approvedCount: number;
  changesRequestedCount: number;
  requiredApprovals?: number;
  approvalsRemaining?: number;
  canApprove: boolean;
  canRequestChanges: boolean;
  canClear: boolean;
  requestChangesRequiresBody: boolean;
  unavailableReason?: string;
}

export interface PullRequestProvider {
  readonly name: ProviderName;
  /** Fetches the account identity associated with the configured credential. */
  getConnectionIdentity(): Promise<{
    externalAccountId: string;
    displayName: string;
  }>;
  /** Lists every repository accessible through the provider connection. */
  listRepositories(): Promise<RepositoryIdentity[]>;
  /** Lists repository branches with their immutable current revisions. */
  listBranches(repositoryExternalId: string): Promise<RepositoryBranch[]>;
  /** Resolves one exact branch without accepting tags or arbitrary refs. */
  getBranch(
    repositoryExternalId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<RepositoryBranch>;
  /** Ensures provider events for this repository reach the signed SaaS endpoint. */
  ensureRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
    secret: string;
  }): Promise<string[]>;
  /** Removes provider events previously registered for this application. */
  removeRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
    remoteHookIds: string[];
  }): Promise<void>;
  /** Lists open pull requests for a provider repository. */
  listOpenPullRequests(
    repositoryExternalId: string,
    options?: PullRequestListOptions,
  ): Promise<PullRequestSummary[]>;
  /** Fetches normalized metadata for one pull request. */
  getPullRequest(
    repositoryExternalId: string,
    number: number,
  ): Promise<PullRequestSummary>;
  /** Fetches the current authenticated reviewer's live provider decision. */
  getPullRequestReviewState(
    repositoryExternalId: string,
    number: number,
  ): Promise<ProviderPullRequestReviewState>;
  /** Submits an exact-revision review decision through the provider. */
  setPullRequestReviewDecision(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
    action: ProviderReviewAction;
    body?: string;
  }): Promise<void>;
  /** Fetches the changed source files required for static analysis. */
  getChangedFiles(
    repositoryExternalId: string,
    number: number,
    options?: ChangedFilesOptions,
  ): Promise<SourceFile[]>;
  /** Lists regular files in an immutable repository revision. */
  listRepositoryFiles(
    repositoryExternalId: string,
    ref: string,
  ): Promise<string[]>;
  /** Fetches file content at a provider revision within the requested limit. */
  getFileContent(
    repositoryExternalId: string,
    path: string,
    ref: string,
    maximumBytes?: number,
  ): Promise<string | undefined>;
  /** Lists and normalizes inline review conversations from the provider. */
  listInlineCommentThreads(
    repositoryExternalId: string,
    pullRequestNumber: number,
  ): Promise<ProviderReviewThread[]>;
  /** Publishes an inline review comment to the code provider. */
  publishInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
    path: string;
    line: number;
    side: "left" | "right";
    body: string;
    idempotencyKey: string;
  }): Promise<{ externalId: string }>;
  /** Publishes a reply inside an existing provider review thread. */
  replyToInlineThread(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    parentCommentExternalId: string;
    body: string;
  }): Promise<{ externalId: string }>;
  /** Marks a provider review conversation resolved or open again. */
  setInlineThreadResolution(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    resolved: boolean;
  }): Promise<void>;
  /** Rewrites the body of one comment the reviewer authored. */
  editInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    commentExternalId: string;
    body: string;
  }): Promise<void>;
  /**
   * Removes one comment from a provider review conversation.
   *
   * Deleting every comment of a conversation is how each provider deletes the
   * conversation itself, so callers order the removals rather than asking for
   * a separate thread delete that no provider offers.
   */
  deleteInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    commentExternalId: string;
  }): Promise<void>;
}

export class ProviderError extends Error {
  /** Creates a provider error with provider and HTTP status context. */
  constructor(
    public readonly provider: ProviderName,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}
