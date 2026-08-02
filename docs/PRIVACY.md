# Privacy and data retention

ReviewDuck processes repository metadata, changed source, review state,
comments, and optional AI prompts/results to deliver a review. AI is optional.

In SaaS, source-provider authorization uses a GitHub App, GitLab.com OAuth, or
Microsoft Entra delegated OAuth. ReviewDuck does not accept hosted PATs or user
model keys. OAuth credentials and service subkeys use per-workspace envelope
encryption. Source and SCIP artifacts are private UploadThing objects in
Frankfurt; object metadata contains no repository path, commit, or user.
Authorized browsers receive a non-persisted 60-second signed URL and download
directly from UploadThing.

Free Big Pickle is limited to provider-verified public SaaS repositories. Paid
AI uses a service-owned OpenRouter workspace subkey and requires Zero Data
Retention. The current Big Pickle disclosure states that processing occurs in
the United States, access is limited-time, and submitted data may be used for
model improvement. Consent is versioned and revocable.

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
Optional provider or AI credentials are encrypted there. Big Pickle contacts
OpenCode only after disclosure acceptance; locally configured providers are
contacted only after explicit selection.

Operators accepting other users' data must publish their controller identity,
subprocessors, regional scope, contact address, and legally required
deletion/export timelines.
