# Release policy

Releases use semantic versioning and immutable `vMAJOR.MINOR.PATCH` tags. The
container workflow publishes the tag and digest, attaches build provenance and
an SBOM, scans the image, and signs the digest with Sigstore keyless signing.
Consumers should pin a digest for production use and verify the signature.

## v0.5.0

- Adds rendered Markdown diffs, opt-in Mermaid diagrams, Jupyter notebook
  previews, line comments in rendered Markdown, and commit history for selected
  code. Whitespace and moved-code controls help focus on meaningful changes.
- Adds a full-screen Discussions workspace with GitHub PR comments and review
  summaries, searchable conversations, pasted comment images, and attachment
  zoom controls shared with the PR description.
- Adds batched folder review checkboxes with reliable undo, a `V` shortcut to
  expand or collapse the current file, clearer review progress, and more stable
  folds, navigation, and scroll positions while reviews update.
- Keeps PR revisions, discussions, AI review progress, approvals, and merge
  readiness current. Adds inbox involvement filters, branch and sync details,
  conflict badges, direct PR-link imports, and recoverable source synchronization.
- Adds personal provider identities for publishing review comments and GitHub
  merges, explicit provider-verified merge requirement bypass, optional AI finding
  publication, and copyable AI fix prompts.
- Adds reviewer evaluation datasets and prompt experiments, GitHub App repository
  access management, and production dependency and appliance runtime updates.
  Pins patched transitive Glob, minimatch, and KaTeX dependencies.

Existing named volumes remain compatible. Startup creates a verified database
backup before applying migrations 0014 through 0019, which add PR metadata,
personal publication identities, evaluation storage, and synchronization cache
metadata. Reuse the same volume to preserve owner sessions, repositories,
reviews, provider credentials, model settings, and stored source data. Never
delete `open-review-duck-data` when updating.

The appliance version comes from the Docker `REVIEWDUCK_VERSION` build argument
and release tag; the private application package version remains unchanged.

## v0.4.0

- Makes review navigation faster and more predictable with file-granular
  source hydration, explorer-ordered Files mode, collapsed reviewed folders,
  mode-aware commands, and restored view state across navigation.
- Adds bidirectional diff-context reveal, queue-aware optimistic sign-off undo,
  and more reliable navigation to compact provider discussion cards.
- Adds an explicit line-action chooser for provider comments and private AI
  questions, keyboard shortcuts for each action, and clearer symbol-hover
  feedback.
- Improves GitHub App merge and review handoff behavior by honoring installation
  token grants, explaining rebase conflicts before merge, and avoiding
  unsupported personal-review synchronization.
- Prevents merged and closed pull requests from re-entering preparation after
  terminal provider webhooks, and refreshes audited application and appliance
  dependencies.

Existing named volumes remain compatible. Reusing the volume preserves local
owner access, repositories, reviews, provider credentials, model settings, and
stored source data.

## v0.3.0

- Adds Amazon Bedrock and Azure AI Foundry to the local appliance provider
  presets, including provider-specific credentials and connection checks.
- Keeps Files-mode review navigation aligned with the changed-file sidebar,
  including whole-file review cards for empty and context-only files.
- Makes individual review units foldable, folds previously reviewed units by
  default, and adds compact per-unit sign-off and undo controls.
- Advances to the next file after file sign-off, keeps large-source notices
  inside the selected card frame, and simplifies the documented Docker owner
  bootstrap command.

Existing named volumes remain compatible. Reusing the volume preserves local
owner access, repositories, reviews, provider credentials, and model settings.

Security fixes are backported to the latest supported major release when
practical. Breaking configuration, schema, or API changes require a major
release and migration notes. Every release must pass unit tests, PostgreSQL
integration tests, migration-drift checks, both deployment builds, the local
appliance journey, production dependency audit, and container scan.
