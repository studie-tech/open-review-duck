import { isLikelyBinaryFile } from "~/server/analysis/types";
import {
  providerFetch,
  providerResponse,
  providerText,
  providerVoid,
} from "./http";
import { collectProviderSourceFiles } from "./source-budget";
import type {
  ChangedFilesOptions,
  ProviderPullRequestReviewState,
  ProviderReviewAction,
  PullRequestListOptions,
  PullRequestProvider,
  PullRequestSummary,
  RepositoryBranch,
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
  author: { id: number; username: string; avatar_url: string | null };
  changes_count?: string;
}
interface GitLabApprovals {
  approvals_required: number;
  approvals_left: number;
  approved_by: Array<{
    user: { id: number; name: string; username: string };
  }>;
}
interface GitLabChange {
  old_path: string;
  new_path: string;
  deleted_file: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}
interface GitLabTreeEntry {
  path: string;
  type: "blob" | "tree";
}
interface GitLabBranch {
  name: string;
  web_url: string;
  commit: { id: string };
}
interface GitLabProjectHook {
  id: number;
  url: string;
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
    this.headers = { Authorization: `Bearer ${token}` };
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
  /** Lists every branch visible through the configured GitLab credential. */
  async listBranches(
    repositoryExternalId: string,
  ): Promise<RepositoryBranch[]> {
    const projectId = encodeURIComponent(repositoryExternalId);
    const [project, branches] = await Promise.all([
      providerFetch<GitLabProject>(
        this.name,
        `${this.apiUrl}/projects/${projectId}`,
        { headers: this.headers },
      ),
      this.getAllPages<GitLabBranch>(
        `${this.apiUrl}/projects/${projectId}/repository/branches?per_page=100`,
      ),
    ]);
    return branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit.id,
      webUrl: branch.web_url,
      isDefault: branch.name === project.default_branch,
    }));
  }

  /** Resolves one GitLab branch and rejects arbitrary refs. */
  async getBranch(
    repositoryExternalId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<RepositoryBranch> {
    const projectId = encodeURIComponent(repositoryExternalId);
    const [project, resolved] = await Promise.all([
      providerFetch<GitLabProject>(
        this.name,
        `${this.apiUrl}/projects/${projectId}`,
        { headers: this.headers, signal },
      ),
      providerFetch<GitLabBranch>(
        this.name,
        `${this.apiUrl}/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
        { headers: this.headers, signal },
      ),
    ]);
    return {
      name: resolved.name,
      sha: resolved.commit.id,
      webUrl: resolved.web_url,
      isDefault: resolved.name === project.default_branch,
    };
  }
  /** Creates one idempotent merge-request hook for an imported project. */
  async ensureRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
    secret: string;
  }) {
    const project = encodeURIComponent(input.repositoryExternalId);
    const hooks = await this.getAllPages<GitLabProjectHook>(
      `${this.apiUrl}/projects/${project}/hooks?per_page=100`,
    );
    const matching = hooks.filter((hook) => hook.url === input.callbackUrl);
    const body = JSON.stringify({
      url: input.callbackUrl,
      signing_token: input.secret,
      merge_requests_events: true,
      enable_ssl_verification: true,
      name: "ReviewDuck",
    });
    const primary = matching[0]
      ? await providerFetch<GitLabProjectHook>(
          this.name,
          `${this.apiUrl}/projects/${project}/hooks/${matching[0].id}`,
          {
            method: "PUT",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body,
          },
        )
      : await providerFetch<GitLabProjectHook>(
          this.name,
          `${this.apiUrl}/projects/${project}/hooks`,
          {
            method: "POST",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body,
          },
        );
    const duplicateCleanup = await Promise.allSettled(
      matching
        .slice(1)
        .map((hook) =>
          providerVoid(
            this.name,
            `${this.apiUrl}/projects/${project}/hooks/${hook.id}`,
            { method: "DELETE", headers: this.headers },
            [404],
          ),
        ),
    );
    for (const [index, result] of duplicateCleanup.entries()) {
      if (result.status === "rejected") {
        console.warn("Duplicate GitLab webhook cleanup failed", {
          hookId: matching[index + 1]?.id,
          cause: result.reason,
        });
      }
    }
    return [String(primary.id)];
  }
  /** Removes every matching application hook from a GitLab project. */
  async removeRepositoryWebhook(input: {
    repositoryExternalId: string;
    callbackUrl: string;
    remoteHookIds: string[];
  }) {
    const project = encodeURIComponent(input.repositoryExternalId);
    await Promise.all(
      input.remoteHookIds.map((hookId) =>
        providerVoid(
          this.name,
          `${this.apiUrl}/projects/${project}/hooks/${encodeURIComponent(hookId)}`,
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
      ? `&reviewer_id=${encodeURIComponent(options.reviewerExternalAccountId)}`
      : "";
    const items = await this.getAllPages<GitLabMergeRequest>(
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/merge_requests?state=opened&per_page=100${reviewer}`,
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
  /** Fetches GitLab's live approval rule and authenticated-user state. */
  async getPullRequestReviewState(
    repositoryExternalId: string,
    number: number,
  ): Promise<ProviderPullRequestReviewState> {
    const project = encodeURIComponent(repositoryExternalId);
    const [approvals, user, mergeRequest] = await Promise.all([
      providerFetch<GitLabApprovals>(
        this.name,
        `${this.apiUrl}/projects/${project}/merge_requests/${number}/approvals`,
        { headers: this.headers },
      ),
      providerFetch<GitLabUser>(this.name, `${this.apiUrl}/user`, {
        headers: this.headers,
      }),
      providerFetch<GitLabMergeRequest>(
        this.name,
        `${this.apiUrl}/projects/${project}/merge_requests/${number}`,
        { headers: this.headers },
      ),
    ]);
    const approved = approvals.approved_by.some(
      ({ user: reviewer }) => reviewer.id === user.id,
    );
    const unavailableReason =
      mergeRequest.state !== "opened"
        ? "This merge request is no longer open for review."
        : undefined;
    return {
      decision: approved ? "approved" : "none",
      actorName: user.name || user.username,
      approvedCount: approvals.approved_by.length,
      changesRequestedCount: 0,
      requiredApprovals: approvals.approvals_required,
      approvalsRemaining: approvals.approvals_left,
      canApprove: !approved && !unavailableReason,
      canRequestChanges: false,
      canClear: approved && !unavailableReason,
      requestChangesRequiresBody: false,
      unavailableReason,
    };
  }
  /** Approves or withdraws approval for the exact GitLab merge-request head. */
  async setPullRequestReviewDecision(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    headSha: string;
    action: ProviderReviewAction;
    body?: string;
  }) {
    if (input.action === "request_changes") {
      throw new Error("GitLab does not expose a request-changes decision");
    }
    const endpoint = `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}`;
    if (input.action === "clear") {
      await providerVoid(this.name, `${endpoint}/unapprove`, {
        method: "POST",
        headers: this.headers,
      });
      return;
    }
    await providerVoid(this.name, `${endpoint}/approve`, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sha: input.headSha }),
    });
  }
  /** Fetches the changed source files required for static analysis. */
  async getChangedFiles(
    repositoryExternalId: string,
    number: number,
    options?: ChangedFilesOptions,
  ) {
    const changes = await this.getAllPages<GitLabChange>(
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/merge_requests/${number}/diffs?per_page=100`,
    );
    const pull = await this.getPullRequest(repositoryExternalId, number);
    return collectProviderSourceFiles(
      changes,
      options?.maximumSourceBytes,
      async (change) => {
        const path = change.deleted_file ? change.old_path : change.new_path;
        const ref = change.deleted_file ? pull.baseSha : pull.headSha;
        const knownBinary = isLikelyBinaryFile(path);
        const changeType = change.deleted_file
          ? ("deleted" as const)
          : change.new_file
            ? ("added" as const)
            : change.renamed_file
              ? ("renamed" as const)
              : ("modified" as const);
        const oversizedHash = `${ref}:${path}`;
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
        const needsPrevious = !change.new_file && !change.deleted_file;
        const previousContent = needsPrevious
          ? await this.getFileContent(
              repositoryExternalId,
              change.old_path,
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
    const entries = await this.getAllPages<GitLabTreeEntry>(
      `${this.apiUrl}/projects/${encodeURIComponent(repositoryExternalId)}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=100`,
    );
    return entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
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
          "Idempotency-Key": input.idempotencyKey,
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

  /** Resolves or reopens one GitLab merge-request discussion. */
  async setInlineThreadResolution(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    resolved: boolean;
  }) {
    await providerFetch<GitLabDiscussion>(
      this.name,
      `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}/discussions/${encodeURIComponent(input.threadExternalId)}`,
      {
        method: "PUT",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: input.resolved }),
      },
    );
  }

  /** Rewrites one note of a GitLab merge-request discussion. */
  async editInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    commentExternalId: string;
    body: string;
  }) {
    await providerFetch<GitLabDiscussionNote>(
      this.name,
      `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}/discussions/${encodeURIComponent(input.threadExternalId)}/notes/${encodeURIComponent(input.commentExternalId)}`,
      {
        method: "PUT",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body: input.body }),
      },
    );
  }

  /** Deletes one note of a GitLab merge-request discussion. */
  async deleteInlineComment(input: {
    repositoryExternalId: string;
    pullRequestNumber: number;
    threadExternalId: string;
    commentExternalId: string;
  }) {
    await providerVoid(
      this.name,
      `${this.apiUrl}/projects/${encodeURIComponent(input.repositoryExternalId)}/merge_requests/${input.pullRequestNumber}/discussions/${encodeURIComponent(input.threadExternalId)}/notes/${encodeURIComponent(input.commentExternalId)}`,
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
