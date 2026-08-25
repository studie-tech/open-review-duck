# Privacy and data retention

ReviewDuck processes repository metadata, changed source, review state,
comments, and optional AI prompts/results to deliver a review. AI is optional.

In SaaS, source-provider authorization uses a GitHub App, GitLab.com OAuth, or a
provider personal access token supplied by a workspace administrator. Azure
DevOps supports personal access tokens only. ReviewDuck does not accept user
model keys. OAuth credentials, provider PATs, service subkeys, and AI
transcripts are encrypted with workspace-derived keys rooted in a Vercel
Sensitive Environment Variable.
Losing or replacing that root makes the encrypted records unreadable.
Source and SCIP artifacts are private UploadThing objects in Frankfurt; object
metadata contains no repository path, commit, or user.
Authorized browsers receive a non-persisted 60-second signed URL and download
directly from UploadThing.

SaaS AI uses one deployment-managed model through a service-owned OpenRouter
workspace subkey and requires Zero Data Retention. Free and subscribed accounts
use the same model with different monthly token allowances. SaaS users never
provide model credentials or select a provider or model.

Workflow event payloads contain identifiers, hashes, counters, and statuses
only. Source, prompts, tool output, model output, credentials, and signed URLs
remain in application storage. Hard deletion removes turns, tool records,
evidence, chunks, and final results.

SaaS source snapshots are pruned after 30 days or when more than five snapshots
exist for a pull request by default. Operators can reduce both limits with
`SOURCE_RETENTION_DAYS` and `SOURCE_RETENTION_SNAPSHOTS`. Unreferenced objects
are transactionally claimed, deleted, and reconciled daily.

Sentry receives errors, sampled traces, releases, and redacted structured
completion events with default PII disabled. Source, prompts, output,
credentials, OAuth data, storage identifiers, signed URLs, repository paths,
request bodies, cookies, and authorization headers are prohibited.

The local appliance sends no telemetry and performs no network request during
startup or ordinary non-AI use. All state remains in the `/data` volume.
Optional provider or AI credentials are encrypted there. Locally configured
providers are contacted only after explicit selection.

The first local start prints a 15-minute owner link. Once an active owner
session exists, restarts do not mint another link. The explicit bootstrap
administration command revokes existing sessions before printing a replacement,
so its output must be treated as a credential until it expires or is exchanged.

Operators accepting other users' data must publish their controller identity,
subprocessors, regional scope, contact address, and legally required
deletion/export timelines.
