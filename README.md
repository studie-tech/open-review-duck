<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/reviewduck-readme-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./public/reviewduck-readme-light.svg" />
    <img src="./public/reviewduck-readme-light.svg" width="100%" alt="ReviewDuck.ai — For those of us who still have to review all the AI slop." />
  </picture>
</p>

ReviewDuck is a human-centered pull-request review workspace for GitHub,
GitLab, and Azure DevOps. It turns a changed codebase into a dependency-aware
review path, preserves progress across revisions only while it remains valid,
and keeps AI in a read-only, evidence-backed supporting role.

The project is pre-release. The schema and public interfaces may change until
the first stable release.

## What ReviewDuck does

- **Builds a review path, not just a diff.** Tree-sitter identifies definitions,
  references, tests, imports, and structural relationships, then orders review
  units from foundations toward dependent behavior.
- **Groups related changes generically.** High-confidence definition/reference
  relationships can combine associated edits and removals into one multi-range
  concept without language- or framework-specific special cases.
- **Keeps progress revision-safe.** Every sign-off is tied to semantic content.
  A resync preserves unaffected sign-offs, reopens changed concepts and affected
  dependents, and never treats interface-only UI updates as source changes.
- **Maintains a real review inbox.** Repository intake can be manual, limited to
  pull requests assigned to the connected reviewer, or set to every open pull
  request. Enabling automation shows an impact preview and requires confirmation.
- **Separates work from history.** The dashboard distinguishes reviews that need
  attention, completed reviews awaiting a provider outcome, merged or closed
  history, and items intentionally removed from the personal queue. Removal is
  reversible, and the same revision is not immediately re-added by automation.
- **Finishes the provider workflow in place.** ReviewDuck reads live approval
  state and, when the connected identity is eligible, can approve, request
  changes or reject, clear a decision, publish inline comments, and reply to
  provider conversations without leaving the review.
- **Supports focused and full-PR AI investigation.** The assistant can explain a
  selected concept, answer follow-up questions, or investigate the whole pull
  request with revision-bound search, source, Tree-sitter, and SCIP tools.

Tree-sitter parsing and browser highlighting cover the 62 grammar-backed
languages registered in
[`tree-sitter-languages.json`](./tree-sitter-languages.json), including SQL.
Server grammars load lazily into a bounded cache. Browser grammars and the WASM
runtime are bundled with the application, loaded only when requested, and kept
outside the client JavaScript bundle. An exact-revision SCIP artifact augments
definitions and references when one is available; stale artifacts are never
used.

## Deployment modes

ReviewDuck has two build-time deployment targets. They share review, analysis,
workflow, and AI domain logic, but do not register one another's hosted
dependencies or credential interfaces.

| Capability | Local appliance | SaaS target |
| --- | --- | --- |
| Authentication | One local owner with an expiring bootstrap link and signed session | Clerk users and workspaces |
| Database | Bundled PostgreSQL 18 | PlanetScale PostgreSQL 18 |
| Source storage | Private content-addressed files on `/data` | Private UploadThing objects in Frankfurt |
| Durable execution | Postgres Workflow World in the appliance | Vercel Workflows |
| Code-provider credentials | Encrypted local PATs; custom/self-managed hosts supported | GitHub App, GitLab.com OAuth, and Microsoft Entra OAuth |
| AI credentials | Optional Big Pickle, local endpoints, or encrypted BYOK | Service-owned Big Pickle and OpenRouter only |
| Observability | Redacted stdout/stderr logs; no telemetry | Sentry errors, traces, releases, and redacted structured logs |

## Zero-configuration local appliance

The published multi-architecture image contains the standalone Next.js
application, PostgreSQL 18, the Postgres Workflow worker, migrations, Git,
certificate authorities, Tree-sitter grammars, browser assets, local
authentication, and private content-addressed storage. The default experience
requires no environment variables, online account, external database, or
hosted ReviewDuck service.

```bash
docker run --detach \
  --name open-review-duck \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v open-review-duck-data:/data \
  ghcr.io/studie-tech/open-review-duck:<version>

docker logs --follow open-review-duck
```

The first boot prints a one-time owner URL. Open it within 15 minutes; the token
is stored only as a hash and is consumed immediately after exchange. The
resulting local session is HTTP-only and same-site. Later starts reuse the
persistent owner session and workspace.

Open [http://localhost:3000](http://localhost:3000), add a provider connection,
choose the repositories available to ReviewDuck, and select an intake policy.
The settings UI includes provider-specific instructions for the minimum useful
permissions:

- GitHub: a fine-grained token with repository contents read access and pull
  requests read/write access.
- GitLab: an `api`-scoped personal, project, or group token with an identity
  eligible to approve merge requests.
- Azure DevOps: a PAT for one organization with Code read/write access.

Tokens, optional BYOK material, local model settings, encryption keys, reviews,
workflows, source objects, and backups remain on the named volume.
PostgreSQL listens only on an internal Unix socket. The application does not
contact Clerk, PlanetScale, UploadThing, Vercel, AWS KMS, or Sentry in local
mode.

Keep the documented loopback port binding. The current local appliance rejects
non-loopback hosts and does not support LAN or reverse-proxy exposure. This is
an intentional pre-release boundary, not a configurable deployment mode.

### Local administration

The appliance exposes administration commands without publishing PostgreSQL:

```bash
# Health, version, disk, session, repository, and snapshot status
docker exec open-review-duck reviewduck-local admin status

# Revoke local sessions and print a fresh one-time owner link
docker exec open-review-duck reviewduck-local admin bootstrap

# Create or verify a PostgreSQL custom-format backup
docker exec open-review-duck reviewduck-local admin backup
docker exec open-review-duck reviewduck-local admin verify-backup

# Export review records as JSON
docker exec open-review-duck reviewduck-local admin export
```

To restore, stop the normal appliance and run the same immutable image against
its volume in administration mode:

```bash
docker stop open-review-duck
docker run --rm --volumes-from open-review-duck \
  ghcr.io/studie-tech/open-review-duck:<version> \
  admin restore /data/backups/<backup>.dump
docker start open-review-duck
```

On a schema-changing image upgrade, the entrypoint creates and verifies a
pre-upgrade backup before applying committed migrations. It retains the three
most recent automatic upgrade backups and refuses to start when the data volume
has critically low free space.

### Local AI

AI is optional and no AI service is required for ordinary review work. Provider
sync, comments, and approval actions still require access to the connected code
provider. The built-in Big Pickle option requires internet access but no user
API key. It remains disabled until the local owner accepts a disclosure
explaining that selected source, prompts, tool results, and output are sent
directly to OpenCode-hosted infrastructure in the US, may be used for model
improvement, and may only be free for a limited period. High-confidence
secret-bearing and excluded files are not sent through the free tier.

Release of account-free Big Pickle access is gated on OpenCode permitting
third-party use of its public mechanism. If availability, authentication, or
terms change, it fails closed and never selects a paid model automatically.

Local installations can instead configure Ollama, an OpenAI-compatible local
endpoint, OpenRouter, OpenAI, Anthropic, or another explicitly supported BYOK
provider. Credentials and headers are encrypted in the local volume. Private
model hosts are allowed only in the local target and remain subject to SSRF and
redirect checks.

## SaaS target

The commercial target is designed for Vercel Pro in `fra1` with Fluid Compute:

- Next.js 16, React 19, TypeScript, tRPC, Drizzle, XState, and TanStack Query.
- PlanetScale PostgreSQL 18 in AWS `eu-central-1`. Runtime queries use
  transaction-mode PgBouncer on port 6432; migrations use the direct port 5432
  endpoint under a migration lock.
- Private UploadThing storage in Frankfurt. Provider source is ingested
  server-side under workspace-scoped content identities. Authorized browsers
  receive 60-second signed URLs and download directly from UploadThing rather
  than proxying source through Vercel.
- Vercel Workflows for pull-request synchronization and AI investigation, with
  identifier-only workflow payloads.
- Clerk authentication, workspace entitlements, and billing.
- Workspace-scoped envelope encryption using AWS KMS through Vercel OIDC; no
  static AWS access key is required.
- Sentry errors, sampled traces, releases, source maps, and redacted structured
  logs. Sentry is excluded from the local build.
- One authenticated daily maintenance route for source retention, orphan
  cleanup, expired rate limits, and managed-model metadata.

SaaS users never paste source-provider PATs or model API keys. GitHub uses
short-lived GitHub App installation tokens, GitLab.com uses OAuth authorization
code flow with PKCE and rotating refresh tokens, and Azure DevOps Services uses
Microsoft Entra delegated OAuth. Custom/self-managed provider URLs are
local-only.

Free SaaS AI is service-owned Big Pickle and is limited to repositories the
source provider reports as public. Paid workspaces use an operator allowlist of
tool-capable OpenRouter models. ReviewDuck creates an encrypted, provider-limited
workspace subkey, reserves estimated cost before inference, settles actual
usage, and requires Zero Data Retention with provider fallback and data
collection disabled. Missing entitlement, catalog, budget, or ZDR availability
fails closed.

See [`.env.example`](./.env.example) for the complete SaaS deployment contract.
Production startup rejects missing platform credentials, an incorrectly pooled
PlanetScale URL, a non-HTTPS application URL, or a non-Frankfurt KMS region.

## Durable AI investigation

AI SDK Core drives an explicit, persisted investigation loop. Default hard
limits are:

- 64 model steps and 256 read-only tool calls.
- Four concurrent independent tool reads.
- 200 distinct source files and 8 MiB of decoded source slices.
- 30 minutes, additionally bounded by workspace token and monetary budgets.

The agent prefers repository maps, Tree-sitter symbols, exact-revision SCIP,
search, and bounded source slices over repeatedly loading whole files. Every
turn, tool request/result, evidence record, usage item, and output chunk is
persisted before the next step. Model inference is not automatically retried,
avoiding duplicate charges after ambiguous provider failures. Authenticated SSE
resumes from a chunk cursor; cancellation and hard deletion remove the
application-owned transcript, tools, chunks, and evidence.

Workflow state contains IDs, hashes, counters, and statuses only. Source,
prompts, model output, credentials, tool results, and signed URLs remain in
private application storage.

## Source development

Requirements:

- Node.js 24 or newer.
- Corepack and the repository-pinned pnpm version.
- Git.
- Docker for the managed development database.

The normal development workflow needs no `.env` file:

```bash
make install
make start
```

`make start` provisions a dedicated PostgreSQL 18 container, generates
checkout-local secrets, applies application and Workflow migrations, prepares
Tree-sitter assets, initializes the local owner, and starts the Turbopack dev
server at [http://localhost:3666](http://localhost:3666). Development state is
stored in the ignored `.reviewduck-dev` directory.

Useful commands:

```bash
make bootstrap   # revoke local sessions and print a fresh owner link
make stop        # stop the managed database without deleting its volume
make check       # docstrings, Biome, TypeScript, and Vitest
make build       # optimized production build
make migrations  # generate a Drizzle migration after schema changes
```

Override the development ports with `PORT` and `DEV_DATABASE_PORT`. To use an
existing PostgreSQL 18 database instead of Docker:

```bash
make start DEV_DATABASE_MANAGED=0 \
  DEV_DATABASE_URL=postgresql://user:password@localhost:5432/reviewduck
```

Apply committed migrations with `pnpm db:migrate` and generate schema changes
with `pnpm db:generate`. Do not use schema push against a shared environment.

## Verification and releases

```bash
make check

DEPLOYMENT_MODE=local NEXT_PUBLIC_DEPLOYMENT_MODE=local \
  SKIP_ENV_VALIDATION=1 DATABASE_URL=postgresql://build:build@localhost/build \
  pnpm build

DEPLOYMENT_MODE=saas NEXT_PUBLIC_DEPLOYMENT_MODE=saas \
  SKIP_ENV_VALIDATION=1 DATABASE_URL=postgresql://build:build@localhost/build \
  pnpm build

docker build --platform linux/amd64 -t open-review-duck:test .
```

CI validates unit and focused PostgreSQL integration tests, committed
migrations, both deployment builds, an offline amd64 local appliance, browser
bootstrap and session persistence, backup archive verification, production
dependencies, container vulnerabilities, and volume persistence. Version tags
publish signed amd64 and arm64 images with SBOMs and build provenance; arm64 is
built but is not yet exercised by the CI appliance journey. Consumers should
pin immutable digests for production deployments.

See [Security](./SECURITY.md), [Privacy and retention](./docs/PRIVACY.md),
[Release policy](./RELEASES.md), [Support](./SUPPORT.md),
[Contributing](./CONTRIBUTING.md), and
[Third-party notices](./THIRD_PARTY_NOTICES.md).

## License

ReviewDuck is licensed under the
[GNU Affero General Public License v3.0](./LICENSE), version 3 only. Commercial
licenses with alternative terms may be offered separately.
