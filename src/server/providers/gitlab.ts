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

interface GitLabProject {
  id: number;
  path: string;
  path_with_namespace: string;
  default_branch: string;
  web_url: string;
  visibility: string;
}
interface GitLabUser {
  id: number;
  username: string;
  name: string;
}
interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "merged";
  draft: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  diff_refs: { base_sha: string; head_sha: string };
  author: { username: string; avatar_url: string | null };
  changes_count?: string;
}
interface GitLabChange {
  old_path: string;
  new_path: string;
  deleted_file: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}
interface GitLabDiscussion {
  id: string;
  notes: GitLabDiscussionNote[];
}
interface GitLabDiscussionNote {
  id: number;
  body: string;
  author: { name: string; username: string; avatar_url?: string | null };
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number;
    old_line?: number;
  };
}
const MAX_PROVIDER_PAGES = 100;
const MAX_PROVIDER_ITEMS = 20_000;

export class GitLabProvider implements PullRequestProvider {
  readonly name = "gitlab" as const;
  private readonly headers: HeadersInit;
  /** Initializes an authenticated provider client. */
  constructor(
    token: string,
    private readonly apiUrl = "https://gitlab.com/api/v4",
  ) {
    this.headers = { "PRIVATE-TOKEN": token };
  }
  /** Fetches the account identity associated with a provider token. */
  async getConnectionIdentity() {
    const user = await providerFetch<GitLabUser>(
      this.name,
      `${this.apiUrl}/user`,
      { headers: this.headers },
    );
    return {
      externalAccountId: String(user.id),
      displayName: user.name || user.username,
    };
  }
  /** Lists every repository accessible through the provider connection. */
  async listRepositories(): Promise<RepositoryIdentity[]> {
    const projects = await this.getAllPages<GitLabProject>(
      `${this.apiUrl}/projects?membership=true&order_by=last_activity_at&per_page=100`,
    );
    return projects.map((project) => ({
      externalId: String(project.id),
      owner: project.path_with_namespace.slice(0, -(project.path.length + 1)),
      name: project.path,
      defaultBranch: project.default_branch,
      webUrl: project.web_url,
      isPrivate: project.visibility !== "public",
    }));
  }
  /** Lists open pull requests for a provider repository. */
  async listOpenPullRequests(repositoryExternalId: string) {
    const items = await this.getAllPages<GitLabMergeRequest>(
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/merge_requests?state=opened&per_page=100`,
    );
    return items.map((item) => this.normalize(item));
  }
  /** Fetches normalized metadata for one pull request. */
  async getPullRequest(repositoryExternalId: string, number: number) {
    return this.normalize(
      await providerFetch<GitLabMergeRequest>(
        this.name,
        `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/merge_requests/${number}`,
        { headers: this.headers },
      ),
    );
  }
  /** Fetches the changed source files required for static analysis. */
  async getChangedFiles(repositoryExternalId: string, number: number) {
    const changes = await this.getAllPages<GitLabChange>(
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/merge_requests/${number}/diffs?per_page=100`,
    );
    const pull = await this.getPullRequest(repositoryExternalId, number);
    return mapWithConcurrency(changes, 8, async (change) => {
      const path = change.deleted_file ? change.old_path : change.new_path;
      const ref = change.deleted_file ? pull.baseSha : pull.headSha;
      const knownBinary = isLikelyBinaryFile(path);
      const [content, previousContent] = !knownBinary
        ? await Promise.all([
            this.getFileContent(repositoryExternalId, path, ref),
            !change.new_file && !change.deleted_file
              ? this.getFileContent(
                  repositoryExternalId,
                  change.old_path,
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
            ? `${ref}:${path}:${content ?? ""}`
            : undefined,
        changeType: change.deleted_file
          ? ("deleted" as const)
          : change.new_file
            ? ("added" as const)
            : change.renamed_file
              ? ("renamed" as const)
              : ("modified" as const),
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
    const mergeRequest = await providerFetch<GitLabMergeRequest>(
      this.name,
      `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}`,
      { headers: this.headers },
    );
    const discussion = await providerFetch<GitLabDiscussion>(
      this.name,
      `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}/discussions`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: input.body,
          position: {
            position_type: "text",
            base_sha: mergeRequest.diff_refs.base_sha,
            start_sha:
              (
                mergeRequest.diff_refs as GitLabMergeRequest["diff_refs"] & {
                  start_sha?: string;
                }
              ).start_sha ?? mergeRequest.diff_refs.base_sha,
            head_sha: mergeRequest.diff_refs.head_sha,
            ...(input.side === "left"
              ? { old_path: input.path, old_line: input.line }
              : { new_path: input.path, new_line: input.line }),
          },
        }),
      },
    );
    return { externalId: discussion.id };
  }

  /** Publishes a note inside an existing GitLab merge-request discussion. */
  async replyToInlineThread(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    parentCommentExternalId: string;
    body: string;
  }) {
    const note = await providerFetch<GitLabDiscussionNote>(
      this.name,
      `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}/discussions/${encodeURIComponent(input.threadExternalId)}/notes`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: input.body }),
      },
    );
    return { externalId: String(note.id) };
  }

  /** Lists and normalizes inline review conversations from the provider. */
  async listInlineCommentThreads(
    repositoryExternalId: string,
    pullRequestNumber: number,
  ) {
    const discussions = await this.getAllPages<GitLabDiscussion>(
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/merge_requests/${pullRequestNumber}/discussions?per_page=100`,
    );
    return discussions.flatMap((discussion) => {
      const root = discussion.notes.find(
        (note) => !note.system && note.position,
      );
      const position = root?.position;
      const path = position?.new_path ?? position?.old_path;
      const line = position?.new_line ?? position?.old_line;
      if (!root || !path || !line) return [];
      const comments = discussion.notes.filter((note) => !note.system);
      return [
        {
          externalId: discussion.id,
          path,
          line,
          side: position?.new_line ? ("right" as const) : ("left" as const),
          status: root.resolvable
            ? root.resolved
              ? ("resolved" as const)
              : ("open" as const)
            : ("unknown" as const),
          comments: comments.map((note) => ({
            externalId: String(note.id),
            body: note.body,
            author: note.author.name || note.author.username,
            authorAvatarUrl: note.author.avatar_url ?? undefined,
            createdAt: note.created_at,
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
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: this.headers },
      maximumBytes,
    );
  }
  /** Converts a provider-specific pull request into ReviewDuck's normalized model. */
  private normalize(item: GitLabMergeRequest): PullRequestSummary {
    return {
      externalId: String(item.id),
      number: item.iid,
      title: item.title,
      description: item.description ?? undefined,
      authorLogin: item.author.username,
      authorAvatarUrl: item.author.avatar_url ?? undefined,
      sourceBranch: item.source_branch,
      targetBranch: item.target_branch,
      headSha: item.diff_refs?.head_sha ?? item.sha,
      baseSha: item.diff_refs?.base_sha ?? "",
      state:
        item.state === "opened" ? (item.draft ? "draft" : "open") : item.state,
      webUrl: item.web_url,
      additions: 0,
      deletions: 0,
      changedFiles: Number.parseInt(item.changes_count ?? "0", 10) || 0,
    };
  }

  /** Fetches every page of a paginated provider endpoint. */
  private async getAllPages<T>(initialUrl: string): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<number>();
    let page = 1;
    while (true) {
      if (visited.size >= MAX_PROVIDER_PAGES || visited.has(page)) {
        throw new Error("GitLab pagination exceeded its safety limit");
      }
      visited.add(page);
      const url = new URL(initialUrl);
      url.searchParams.set("page", String(page));
      const response = await providerResponse<T[]>(this.name, url.toString(), {
        headers: this.headers,
      });
      items.push(...response.data);
      if (items.length > MAX_PROVIDER_ITEMS) {
        throw new Error("GitLab pagination exceeded its item limit");
      }
      const nextPage = response.headers.get("x-next-page");
      if (!nextPage) return items;
      page = Number(nextPage);
      if (!Number.isSafeInteger(page) || page < 1)
        throw new Error("GitLab returned an invalid pagination cursor");
    }
  }
}
