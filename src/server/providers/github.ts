import { isLikelyBinaryFile } from "~/server/analysis/types";
import {
  mapWithConcurrency,
  providerFetch,
  providerResponse,
  providerText,
} from "./http";
import type {
  PullRequestProvider,
  PullRequestSummary,
  RepositoryIdentity,
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
  user: { login: string; avatar_url: string };
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}
interface GitHubFile {
  filename: string;
  status: string;
  previous_filename?: string;
  sha?: string;
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
    comments: {
      nodes: {
        fullDatabaseId: number | string | null;
      }[];
    };
    isResolved: boolean;
  }[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
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
  /** Initializes an authenticated provider client. */
  constructor(
    token: string,
    private readonly apiUrl = "https://api.github.com",
  ) {
    this.headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /** Fetches the account identity associated with a provider token. */
  async getConnectionIdentity() {
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
    const repos = await this.getAllPages<GitHubRepository>(
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

  /** Lists open pull requests for a provider repository. */
  async listOpenPullRequests(repositoryExternalId: string) {
    const pulls = await this.getAllPages<GitHubPull>(
      `${this.apiUrl}/repositories/${repositoryExternalId}/pulls?state=open&per_page=100`,
    );
    return mapWithConcurrency(pulls, 8, (pull) =>
      this.getPullRequest(repositoryExternalId, pull.number),
    );
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

  /** Fetches the changed source files required for static analysis. */
  async getChangedFiles(repositoryExternalId: string, number: number) {
    const [files, pull] = await Promise.all([
      this.getAllPages<GitHubFile>(
        `${this.apiUrl}/repositories/${repositoryExternalId}/pulls/${number}/files?per_page=100`,
      ),
      this.getPullRequest(repositoryExternalId, number),
    ]);
    return mapWithConcurrency(files, 8, async (file) => {
      const deleted = file.status === "removed";
      const path =
        deleted && file.previous_filename
          ? file.previous_filename
          : file.filename;
      const ref = deleted ? pull.baseSha : pull.headSha;
      const knownBinary = isLikelyBinaryFile(path);
      const [content, previousContent] = !knownBinary
        ? await Promise.all([
            this.getFileContent(repositoryExternalId, path, ref),
            file.status !== "added" && !deleted
              ? this.getFileContent(
                  repositoryExternalId,
                  file.previous_filename ?? path,
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
            ? (file.sha ?? `${ref}:${path}:${content ?? ""}`)
            : undefined,
        changeType: this.changeType(file.status),
      };
    });
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
    const comment = await providerFetch<GitHubReviewComment>(
      this.name,
      `${this.apiUrl}/repositories/${input.repositoryExternalId}/pulls/${input.pullRequestNumber}/comments`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
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
      const repository = await providerFetch<GitHubRepository>(
        this.name,
        `${this.apiUrl}/repositories/${repositoryExternalId}`,
        { headers: this.headers },
      );
      if (!repository.node_id) return statuses;

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
                            isResolved
                            comments(first: 1) {
                              nodes {
                                fullDatabaseId
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
        const threads: GitHubReviewThreadsConnection | undefined =
          response.data?.node?.pullRequest?.reviewThreads;
        if (!threads) return statuses;
        for (const thread of threads.nodes) {
          const rootId = thread.comments.nodes[0]?.fullDatabaseId;
          if (rootId === null || rootId === undefined) continue;
          statuses.set(String(rootId), thread.isResolved ? "resolved" : "open");
        }
        if (!threads.pageInfo.hasNextPage) return statuses;
        const nextCursor: string | null = threads.pageInfo.endCursor;
        if (!nextCursor || visitedCursors.has(nextCursor)) return statuses;
        visitedCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } catch {
      // Resolution metadata is optional; the REST conversation remains usable.
    }
    return statuses;
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
