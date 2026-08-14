import { isLikelyBinaryFile } from "~/server/analysis/types";
import {
  providerFetch,
  providerResponse,
  providerText,
  providerVoid,
} from "./http";
import { collectProviderSourceFiles } from "./source-budget";
import {
  type ChangedFilesOptions,
  ProviderError,
  type ProviderPullRequestReviewState,
  type ProviderReviewAction,
  type PullRequestListOptions,
  type PullRequestProvider,
  type PullRequestSummary,
  type RepositoryIdentity,
} from "./types";

interface GitHubRepository {
  id: number;
  node_id?: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
}
interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}
interface GitHubInstallation {
  id: number;
  account: { id: number; login?: string; name?: string };
}
interface GitHubInstallationRepositories {
  repositories: GitHubRepository[];
}
interface GitHubPull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  state: "open" | "closed";
  merged_at?: string | null;
  html_url: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  user: { id: number; login: string; avatar_url: string };
  requested_reviewers?: Array<{ id: number; login: string }>;
  assignees?: Array<{ id: number; login: string }>;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}
interface GitHubReview {
  id: number;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "DISMISSED"
    | "PENDING";
  submitted_at?: string;
  user: { id: number; login: string };
}
interface GitHubFile {
  filename: string;
  status: string;
  previous_filename?: string;
  sha?: string;
}
interface GitHubTree {
  truncated: boolean;
  tree: Array<{ path: string; type: "blob" | "tree" | "commit" }>;
}
interface GitHubReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line?: number | null;
  side?: "LEFT" | "RIGHT";
  in_reply_to_id?: number;
  created_at: string;
  html_url: string;
  user: { login: string; avatar_url?: string };
}
interface GitHubReviewThreadsConnection {
  nodes: {
    id: string;
    comments: {
      nodes: {
        fullDatabaseId: number | string | null;
        replyTo: { fullDatabaseId: number | string | null } | null;
      }[];
    };
    isResolved: boolean;
  }[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

interface GitHubResolveThreadResponse {
  data?: {
    resolveReviewThread?: { thread: { isResolved: boolean } | null } | null;
    unresolveReviewThread?: { thread: { isResolved: boolean } | null } | null;
  };
  errors?: { message: string }[];
}
interface GitHubReviewThreadsResponse {
  data?: {
    node?: {
      pullRequest?: {
        reviewThreads: GitHubReviewThreadsConnection;
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}
const MAX_PROVIDER_PAGES = 100;
const MAX_PROVIDER_ITEMS = 20_000;

export class GitHubProvider implements PullRequestProvider {
  readonly name = "github" as const;
  private readonly headers: HeadersInit;
  private readonly repositories = new Map<string, Promise<GitHubRepository>>();
  /** Initializes an authenticated provider client. */
  constructor(
    token: string,
    private readonly apiUrl = "https://api.github.com",
    private readonly installation = false,
  ) {
    this.headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /** Fetches the account identity associated with a provider token. */
  async getConnectionIdentity() {
    if (this.installation) {
      const installation = await providerFetch<GitHubInstallation>(
        this.name,
        `${this.apiUrl}/installation`,
        { headers: this.headers },
      );
      return {
        externalAccountId: String(installation.account.id),
        displayName:
          installation.account.name ??
          installation.account.login ??
          `GitHub installation ${installation.id}`,
      };
    }
    const user = await providerFetch<GitHubUser>(
      this.name,
      `${this.apiUrl}/user`,
      { headers: this.headers },
    );
    return {
      externalAccountId: String(user.id),
      displayName: user.name ?? user.login,
    };
  }

  /** Lists every repository accessible through the provider connection. */
  async listRepositories(): Promise<RepositoryIdentity[]> {
    const repos = this.installation
      ? (
          await providerFetch<GitHubInstallationRepositories>(
            this.name,
            `${this.apiUrl}/installation/repositories?per_page=100`,
            { headers: this.headers },
          )
        ).repositories
      : await this.getAllPages<GitHubRepository>(
          `${this.apiUrl}/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&direction=desc&per_page=100`,
        );
    return repos.map((repo) => ({
      externalId: String(repo.id),
      owner: repo.full_name.split("/", 1)[0] ?? repo.name,
      name: repo.name,
      defaultBranch: repo.default_branch,
      webUrl: repo.html_url,
      isPrivate: repo.private,
    }));
  }
  /**
   * Confirms the GitHub App webhook model.
   *
   * GitHub App webhooks are configured once on the App and automatically cover
   * repositories selected by each installation; creating repository hooks would
   * require broader repository administration permission.
   */
  async ensureRepositoryWebhook(): Promise<string[]> {
    return [];
  }
  /** GitHub App installation removal automatically stops repository delivery. */
  async removeRepositoryWebhook(): Promise<void> {
    if (!this.installation) return;
  }

  /** Lists open pull requests for a provider repository. */
  async listOpenPullRequests(
    repositoryExternalId: string,
    options: PullRequestListOptions = {},
  ) {
    const pulls = await this.getAllPages<GitHubPull>(
      `${this.apiUrl}/repositories/${repositoryExternalId}/pulls?state=open&per_page=100`,
    );
    const reviewerId = options.reviewerExternalAccountId;
    return pulls
      .filter(
        (pull) =>
          !reviewerId ||
          pull.requested_reviewers?.some(
            (reviewer) => String(reviewer.id) === reviewerId,
          ) ||
          pull.assignees?.some(
            (assignee) => String(assignee.id) === reviewerId,
          ),
      )
      .map((pull) => this.normalizePullRequest(pull));
  }

  /** Fetches normalized metadata for one pull request. */
  async getPullRequest(
    repositoryExternalId: string,
    number: number,
  ): Promise<PullRequestSummary> {
    const pull = await providerFetch<GitHubPull>(
      this.name,
      `${this.apiUrl}/repositories/${repositoryExternalId}/pulls/${number}`,
      { headers: this.headers },
    );
    return this.normalizePullRequest(pull);
  }

  /** Normalizes both list and detail responses without an N+1 detail fetch. */
  private normalizePullRequest(pull: GitHubPull): PullRequestSummary {
    return {
      externalId: String(pull.id),
      number: pull.number,
      title: pull.title,
      description: pull.body ?? undefined,
      authorLogin: pull.user.login,
      authorAvatarUrl: pull.user.avatar_url,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      state: pull.merged_at ? "merged" : pull.draft ? "draft" : pull.state,
      webUrl: pull.html_url,
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? 0,
    };
  }

  /** Fetches the latest effective review decision for each GitHub reviewer. */
  async getPullRequestReviewState(
    repositoryExternalId: string,
    number: number,
  ): Promise<ProviderPullRequestReviewState> {
    const [reviews, pull, identity] = await Promise.all([
      this.getAllPages<GitHubReview>(
        `${this.apiUrl}/repositories/${repositoryExternalId}/pulls/${number}/reviews?per_page=100`,
      ),
      providerFetch<GitHubPull>(
        this.name,
        `${this.apiUrl}/repositories/${repositoryExternalId}/pulls/${number}`,
        { headers: this.headers },
      ),
      this.getConnectionIdentity(),
    ]);
    const latestByUser = new Map<number, GitHubReview["state"]>();
    for (const review of reviews) {
      if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
        latestByUser.set(review.user.id, review.state);
      } else if (review.state === "DISMISSED") {
        latestByUser.delete(review.user.id);
      }
    }
    const actorId = Number(identity.externalAccountId);
    const actorDecision = this.installation
      ? undefined
      : latestByUser.get(actorId);
    const selfReview = pull.user.id === actorId;
    const unavailableReason = this.installation
      ? "GitHub App installations can synchronize approval state, but a personal approval must be submitted with your GitHub user identity."
      : selfReview
        ? "GitHub does not allow pull-request authors to approve their own changes."
        : pull.state !== "open"
          ? "This pull request is no longer open for review."
          : undefined;
    return {
      decision:
        actorDecision === "APPROVED"
          ? "approved"
          : actorDecision === "CHANGES_REQUESTED"
            ? "changes_requested"
            : "none",
      actorName: this.installation
        ? "connected GitHub App"
        : identity.displayName,
      approvedCount: [...latestByUser.values()].filter(
        (state) => state === "APPROVED",
      ).length,
      changesRequestedCount: [...latestByUser.values()].filter(
        (state) => state === "CHANGES_REQUESTED",
      ).length,
      canApprove: !unavailableReason && actorDecision !== "APPROVED",
      canRequestChanges:
        !unavailableReason && actorDecision !== "CHANGES_REQUESTED",
      canClear: false,
      requestChangesRequiresBody: true,
      unavailableReason,
    };
  }

  /** Submits a GitHub approval or request-changes review at one exact commit. */
  async setPullRequestReviewDecision(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
    action: ProviderReviewAction;
    body?: string;
  }) {
    if (this.installation) {
      throw new Error(
        "GitHub App installations cannot submit a personal review decision",
      );
    }
    if (input.action === "clear") {
      throw new Error("GitHub does not support withdrawing a submitted review");
    }
    const body = input.body?.trim();
    if (input.action === "request_changes" && !body) {
      throw new Error("GitHub requires a reason when requesting changes");
    }
    await providerFetch<GitHubReview>(
      this.name,
      `${this.apiUrl}/repositories/${input.repositoryExternalId}/pulls/${input.pullRequestNumber}/reviews`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commit_id: input.headSha,
          event: input.action === "approve" ? "APPROVE" : "REQUEST_CHANGES",
          ...(body ? { body } : {}),
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
    const [files, pull] = await Promise.all([
      this.getAllPages<GitHubFile>(
        `${this.apiUrl}/repositories/${repositoryExternalId}/pulls/${number}/files?per_page=100`,
      ),
      this.getPullRequest(repositoryExternalId, number),
    ]);
    return collectProviderSourceFiles(
      files,
      options?.maximumSourceBytes,
      async (file) => {
        const deleted = file.status === "removed";
        const path =
          deleted && file.previous_filename
            ? file.previous_filename
            : file.filename;
        const ref = deleted ? pull.baseSha : pull.headSha;
        const knownBinary = isLikelyBinaryFile(path);
        const changeType = this.changeType(file.status);
        const oversizedHash = file.sha ?? `${ref}:${path}`;
        const skippedFile = {
          path,
          content: "",
          skipReason: "too_large" as const,
          isBinary: false,
          binaryHash: oversizedHash,
          changeType,
        };
        if (knownBinary) {
          return {
            file: {
              path,
              content: "",
              isBinary: true,
              binaryHash: oversizedHash,
              changeType,
            },
          };
        }
        const content = await this.getFileContent(
          repositoryExternalId,
          path,
          ref,
        );
        if (content === undefined) return { file: skippedFile };
        if (isLikelyBinaryFile(path, content)) {
          return {
            file: {
              path,
              content: "",
              isBinary: true,
              binaryHash: oversizedHash,
              changeType,
            },
          };
        }
        const needsPrevious = file.status !== "added" && !deleted;
        const previousContent = needsPrevious
          ? await this.getFileContent(
              repositoryExternalId,
              file.previous_filename ?? path,
              pull.baseSha,
            )
          : undefined;
        if (needsPrevious && previousContent === undefined) {
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
          oversizedHash,
        };
      },
    );
  }

  /** Lists regular files from one exact Git commit tree. */
  async listRepositoryFiles(repositoryExternalId: string, ref: string) {
    const tree = await providerFetch<GitHubTree>(
      this.name,
      `${this.apiUrl}/repositories/${repositoryExternalId}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: this.headers },
    );
    if (tree.truncated) {
      throw new Error("GitHub repository tree exceeded its API limit");
    }
    const paths = tree.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
    if (paths.length > MAX_PROVIDER_ITEMS) {
      throw new Error("GitHub repository tree exceeded its item limit");
    }
    return paths;
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
    const comment = await providerFetch<GitHubReviewComment>(
      this.name,
      `${this.apiUrl}/repositories/${input.repositoryExternalId}/pulls/${input.pullRequestNumber}/comments`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          body: input.body,
          commit_id: input.headSha,
          path: input.path,
          line: input.line,
          side: input.side.toUpperCase(),
        }),
      },
    );
    return { externalId: String(comment.id) };
  }

  /** Publishes a reply to a top-level GitHub review comment. */
  async replyToInlineThread(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    parentCommentExternalId: string;
    body: string;
  }) {
    const comment = await providerFetch<GitHubReviewComment>(
      this.name,
      `${this.apiUrl}/repositories/${input.repositoryExternalId}/pulls/${input.pullRequestNumber}/comments/${encodeURIComponent(input.threadExternalId)}/replies`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: input.body }),
      },
    );
    return { externalId: String(comment.id) };
  }

  /** Lists and normalizes inline review conversations from the provider. */
  async listInlineCommentThreads(
    repositoryExternalId: string,
    pullRequestNumber: number,
  ) {
    const comments = await this.getAllPages<GitHubReviewComment>(
      `${this.apiUrl}/repositories/${repositoryExternalId}/pulls/${pullRequestNumber}/comments?per_page=100`,
    );
    const statuses =
      comments.length > 0
        ? await this.getReviewThreadStatuses(
            repositoryExternalId,
            pullRequestNumber,
          )
        : new Map<string, "open" | "resolved">();
    const repliesByRoot = new Map<number, GitHubReviewComment[]>();
    for (const comment of comments) {
      if (comment.in_reply_to_id === undefined) continue;
      repliesByRoot.set(comment.in_reply_to_id, [
        ...(repliesByRoot.get(comment.in_reply_to_id) ?? []),
        comment,
      ]);
    }
    return comments.flatMap((root) => {
      if (root.in_reply_to_id !== undefined) return [];
      const line = root.line ?? root.original_line;
      if (!line) return [];
      const threadComments = [root, ...(repliesByRoot.get(root.id) ?? [])];
      return [
        {
          externalId: String(root.id),
          path: root.path,
          line,
          side: root.side === "LEFT" ? ("left" as const) : ("right" as const),
          status: statuses.get(String(root.id)) ?? ("unknown" as const),
          webUrl: root.html_url,
          comments: threadComments.map((comment) => ({
            externalId: String(comment.id),
            body: comment.body,
            author: comment.user.login,
            authorAvatarUrl: comment.user.avatar_url,
            createdAt: comment.created_at,
            webUrl: comment.html_url,
          })),
        },
      ];
    });
  }

  /**
   * Resolves or reopens one GitHub review conversation.
   *
   * Resolution lives only in the GraphQL review-thread model, so the REST
   * comment the rest of the application knows a conversation by is translated
   * to its thread node before the mutation runs.
   */
  async setInlineThreadResolution(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    resolved: boolean;
  }) {
    const threads = await this.getReviewThreads(
      input.repositoryExternalId,
      input.pullRequestNumber,
    );
    const nodeId = threads.get(input.threadExternalId)?.nodeId;
    if (!nodeId) {
      throw new ProviderError(
        this.name,
        "GitHub did not report a review thread for this conversation",
        404,
      );
    }
    const field = input.resolved
      ? "resolveReviewThread"
      : "unresolveReviewThread";
    const response = await providerFetch<GitHubResolveThreadResponse>(
      this.name,
      this.graphqlUrl(),
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation ReviewDuckSetReviewThreadResolution($threadId: ID!) {
              ${field}(input: { threadId: $threadId }) {
                thread {
                  isResolved
                }
              }
            }
          `,
          variables: { threadId: nodeId },
        }),
      },
    );
    const failure = response.errors?.[0]?.message;
    if (failure) throw new ProviderError(this.name, failure);
    if (response.data?.[field]?.thread?.isResolved !== input.resolved) {
      throw new ProviderError(
        this.name,
        `GitHub did not ${input.resolved ? "resolve" : "reopen"} this conversation`,
      );
    }
  }

  /** Rewrites one GitHub review comment. */
  async editInlineComment(input: {
    repositoryExternalId: string;
    commentExternalId: string;
    body: string;
  }) {
    await providerFetch<GitHubReviewComment>(
      this.name,
      await this.reviewCommentUrl(
        input.repositoryExternalId,
        input.commentExternalId,
      ),
      {
        method: "PATCH",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body: input.body }),
      },
    );
  }

  /** Deletes one GitHub review comment. */
  async deleteInlineComment(input: {
    repositoryExternalId: string;
    commentExternalId: string;
  }) {
    await providerVoid(
      this.name,
      await this.reviewCommentUrl(
        input.repositoryExternalId,
        input.commentExternalId,
      ),
      { method: "DELETE", headers: this.headers },
    );
  }

  /**
   * Builds the documented route for editing or deleting one review comment.
   *
   * GitHub documents review-comment writes only under `/repos/{owner}/{repo}`,
   * so the repository's full name is read before the request rather than
   * relying on the numeric-id form that reads work through.
   */
  private async reviewCommentUrl(
    repositoryExternalId: string,
    commentExternalId: string,
  ) {
    const repository = await this.repository(repositoryExternalId);
    const [owner, name] = repository.full_name.split("/");
    if (!owner || !name) {
      throw new ProviderError(
        this.name,
        "GitHub did not report a full name for this repository",
      );
    }
    return `${this.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/comments/${encodeURIComponent(commentExternalId)}`;
  }

  /**
   * Enriches REST review comments with thread resolution state.
   *
   * GitHub exposes comments and replies through REST, but only its GraphQL
   * review-thread model includes `isResolved`. Status enrichment is best effort
   * so older enterprise installations or narrower tokens never prevent
   * conversations from loading.
   */
  private async getReviewThreadStatuses(
    repositoryExternalId: string,
    pullRequestNumber: number,
  ) {
    const statuses = new Map<string, "open" | "resolved">();
    try {
      const threads = await this.getReviewThreads(
        repositoryExternalId,
        pullRequestNumber,
      );
      for (const [rootId, { resolved }] of threads) {
        statuses.set(rootId, resolved ? "resolved" : "open");
      }
    } catch {
      // Resolution metadata is optional; the REST conversation remains usable.
    }
    return statuses;
  }

  /**
   * Reads the GraphQL review threads, keyed by their root REST comment.
   *
   * The REST conversation carries comment ids, and resolving one takes the
   * thread's own GraphQL node id, so the two identities are collected together
   * on the one walk that already had to happen for resolution state.
   *
   * Failures are raised rather than absorbed. Only the caller knows whether an
   * incomplete answer is tolerable: listing conversations can do without
   * resolution state, but resolving one must not report a thread as missing
   * when the request for it is what failed.
   */
  private async getReviewThreads(
    repositoryExternalId: string,
    pullRequestNumber: number,
  ) {
    const threads = new Map<string, { nodeId: string; resolved: boolean }>();
    const repository = await this.repository(repositoryExternalId);
    if (!repository.node_id) {
      throw new ProviderError(
        this.name,
        "GitHub did not report a node identifier for this repository",
      );
    }

    const visitedCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PROVIDER_PAGES; page++) {
      const response: GitHubReviewThreadsResponse =
        await providerFetch<GitHubReviewThreadsResponse>(
          this.name,
          this.graphqlUrl(),
          {
            method: "POST",
            headers: {
              ...this.headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: `
                query ReviewDuckReviewThreads(
                  $repositoryId: ID!
                  $number: Int!
                  $after: String
                ) {
                  node(id: $repositoryId) {
                    ... on Repository {
                      pullRequest(number: $number) {
                        reviewThreads(first: 100, after: $after) {
                          nodes {
                            id
                            isResolved
                            comments(first: 1) {
                              nodes {
                                fullDatabaseId
                                replyTo {
                                  fullDatabaseId
                                }
                              }
                            }
                          }
                          pageInfo {
                            hasNextPage
                            endCursor
                          }
                        }
                      }
                    }
                  }
                }
              `,
              variables: {
                repositoryId: repository.node_id,
                number: pullRequestNumber,
                after: cursor,
              },
            }),
          },
        );
      const failure = response.errors?.[0]?.message;
      if (failure) throw new ProviderError(this.name, failure);
      const connection: GitHubReviewThreadsConnection | undefined =
        response.data?.node?.pullRequest?.reviewThreads;
      if (!connection) {
        throw new ProviderError(
          this.name,
          "GitHub did not report the review threads of this pull request",
        );
      }
      for (const thread of connection.nodes) {
        const comment = thread.comments.nodes[0];
        if (!comment) continue;
        // Whichever comment the connection hands back names the root: a reply
        // carries the comment it answers, and the root answers none. Nothing
        // documents the order, and the REST conversation is keyed by its root,
        // so a reply arriving first must not become the key.
        const rootId = comment.replyTo
          ? comment.replyTo.fullDatabaseId
          : comment.fullDatabaseId;
        if (rootId === null || rootId === undefined) continue;
        threads.set(String(rootId), {
          nodeId: thread.id,
          resolved: thread.isResolved,
        });
      }
      if (!connection.pageInfo.hasNextPage) return threads;
      const nextCursor: string | null = connection.pageInfo.endCursor;
      if (!nextCursor || visitedCursors.has(nextCursor)) return threads;
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
    // A walk that ran out of pages describes only part of the pull request,
    // and a caller resolving one conversation would read the rest as absent.
    throw new Error(
      "GitHub review-thread pagination exceeded its safety limit",
    );
  }

  /**
   * Reads one repository's stable identity once per provider instance.
   *
   * A conversation is deleted one comment at a time and each write needs the
   * repository's owner and name, so without this a five-comment thread would
   * spend five more requests re-reading facts that cannot change underneath it.
   */
  private repository(repositoryExternalId: string) {
    const cached = this.repositories.get(repositoryExternalId);
    if (cached) return cached;
    const pending = providerFetch<GitHubRepository>(
      this.name,
      `${this.apiUrl}/repositories/${repositoryExternalId}`,
      { headers: this.headers },
    ).catch((cause: unknown) => {
      // A failed read must not be the answer every later caller receives.
      this.repositories.delete(repositoryExternalId);
      throw cause;
    });
    this.repositories.set(repositoryExternalId, pending);
    return pending;
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
      `${this.apiUrl}/repositories/${repositoryExternalId}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          ...this.headers,
          Accept: "application/vnd.github.raw+json",
        },
      },
      maximumBytes,
    );
  }

  /** Maps a GitHub file status to a normalized change type. */
  private changeType(status: string) {
    if (status === "added") return "added" as const;
    if (status === "removed") return "deleted" as const;
    if (status === "renamed") return "renamed" as const;
    return "modified" as const;
  }

  /** Returns the GraphQL endpoint for GitHub.com or GitHub Enterprise Server. */
  private graphqlUrl() {
    const url = new URL(this.apiUrl);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path.endsWith("/api/v3")
      ? `${path.slice(0, -3)}/graphql`
      : `${path}/graphql`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  /** Fetches every page of a paginated provider endpoint. */
  private async getAllPages<T>(initialUrl: string): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    let url: string | undefined = initialUrl;
    while (url) {
      if (visited.size >= MAX_PROVIDER_PAGES || visited.has(url)) {
        throw new Error("GitHub pagination exceeded its safety limit");
      }
      const requested = new URL(url);
      const allowed = new URL(this.apiUrl);
      const allowedPath = allowed.pathname.replace(/\/$/, "");
      if (
        requested.origin !== allowed.origin ||
        (allowedPath !== "" &&
          requested.pathname !== allowedPath &&
          !requested.pathname.startsWith(`${allowedPath}/`))
      ) {
        throw new Error("GitHub returned an unsafe pagination URL");
      }
      visited.add(url);
      const response = await providerResponse<T[]>(this.name, url, {
        headers: this.headers,
      });
      items.push(...response.data);
      if (items.length > MAX_PROVIDER_ITEMS) {
        throw new Error("GitHub pagination exceeded its item limit");
      }
      url = this.nextLink(response.headers.get("link"));
    }
    return items;
  }

  /** Parses the next-page URL from a GitHub Link header. */
  private nextLink(linkHeader: string | null) {
    if (!linkHeader) return undefined;
    for (const part of linkHeader.split(",")) {
      const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
      if (match?.[2] === "next") return match[1];
    }
    return undefined;
  }
}
