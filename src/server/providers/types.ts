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

export interface ProviderReviewComment {
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

export interface PullRequestProvider {
  readonly name: ProviderName;
  /** Fetches the account identity associated with the configured credential. */
  getConnectionIdentity(): Promise<{
    externalAccountId: string;
    displayName: string;
  }>;
  /** Lists every repository accessible through the provider connection. */
  listRepositories(): Promise<RepositoryIdentity[]>;
  /** Lists open pull requests for a provider repository. */
  listOpenPullRequests(
    repositoryExternalId: string,
  ): Promise<PullRequestSummary[]>;
  /** Fetches normalized metadata for one pull request. */
  getPullRequest(
    repositoryExternalId: string,
    number: number,
  ): Promise<PullRequestSummary>;
  /** Fetches the changed source files required for static analysis. */
  getChangedFiles(
    repositoryExternalId: string,
    number: number,
  ): Promise<SourceFile[]>;
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
  }): Promise<{ externalId: string }>;
  /** Publishes a reply inside an existing provider review thread. */
  replyToInlineThread(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    parentCommentExternalId: string;
    body: string;
  }): Promise<{ externalId: string }>;
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
