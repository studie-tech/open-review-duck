/** Creates a command-requested snapshot and reports its Vercel deployment. */
export async function runPreview({ github, context, core }) {
  const repo = context.repo;
  const number =
    context.payload.issue?.number ?? context.payload.pull_request?.number;
  const branch = `reviewduck-preview/pr-${number}`;
  const token = process.env.PREVIEW_PUSH_TOKEN;
  const write = (route, parameters) =>
    github.request(route, {
      ...repo,
      ...parameters,
      headers: { authorization: `token ${token}` },
    });
  if (context.eventName === "pull_request_target") {
    if (context.payload.action !== "closed") return;
    try {
      await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (!token) {
      core.setFailed(
        "Configure PREVIEW_PUSH_TOKEN to clean up preview branches.",
      );
      return;
    }
    try {
      await write("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        ref: `heads/${branch}`,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    return;
  }
  const firstLine = (context.payload.comment?.body ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
  if (!context.payload.issue?.pull_request || firstLine !== "/create-preview")
    return;
  const { data: permission } =
    await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username: context.payload.comment.user.login,
    });
  if (!["admin", "maintain", "write"].includes(permission.permission)) return;
  const { data: pr } = await github.rest.pulls.get({
    ...repo,
    pull_number: number,
  });
  if (pr.state !== "open") return;
  const { data: comment } = await github.rest.issues.createComment({
    ...repo,
    issue_number: number,
    body: `Creating a Vercel preview of \`${pr.head.sha}\`. Later pushes do not update it; comment \`/create-preview\` again to refresh it.`,
  });
  const update = (body) =>
    github.rest.issues.updateComment({ ...repo, comment_id: comment.id, body });
  try {
    if (!token)
      throw new Error(
        "Configure the PREVIEW_PUSH_TOKEN Actions secret with repository contents write access.",
      );
    const { data: head } = await github.rest.git.getCommit({
      ...repo,
      commit_sha: pr.head.sha,
    });
    // A distinct commit retriggers Vercel even if the same head was requested
    // before. Its tree is exactly the approved PR head, including vercel.json.
    const { data: snapshot } = await write(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        message: `Preview PR #${number} at ${pr.head.sha} (run ${context.runId}, attempt ${process.env.GITHUB_RUN_ATTEMPT ?? "1"})`,
        tree: head.tree.sha,
        parents: [pr.head.sha],
      },
    );
    try {
      await write("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        ref: `heads/${branch}`,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
      await write("POST /repos/{owner}/{repo}/git/refs", {
        ref: `refs/heads/${branch}`,
        sha: snapshot.sha,
      });
    }
    await write("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      ref: `heads/${branch}`,
      sha: snapshot.sha,
      force: true,
    });
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline) {
      const { data: deployments } = await github.rest.repos.listDeployments({
        ...repo,
        sha: snapshot.sha,
        per_page: 100,
      });
      for (const deployment of deployments.filter(
        (entry) =>
          !entry.production_environment &&
          entry.creator?.login === "vercel[bot]",
      )) {
        const { data: statuses } =
          await github.rest.repos.listDeploymentStatuses({
            ...repo,
            deployment_id: deployment.id,
            per_page: 1,
          });
        const status = statuses[0];
        if (status?.state === "success" && status.environment_url) {
          await update(
            `Vercel preview of \`${pr.head.sha}\`: ${status.environment_url}\n\nLater pushes do not update this preview. Comment \`/create-preview\` again to refresh it.`,
          );
          return;
        }
        if (["error", "failure"].includes(status?.state))
          throw new Error(`Vercel deployment failed. ${status.log_url ?? ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    throw new Error(
      "Timed out waiting for Vercel. Check the Vercel Git integration and preview branch deployment settings.",
    );
  } catch (error) {
    await update(`Vercel preview failed: ${error.message}`);
    core.setFailed(error.message);
  }
}
