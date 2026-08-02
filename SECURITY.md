# Security policy

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private security-advisory reporting
flow and include the affected version, deployment target, reproduction, impact,
and any suggested fix. Do not access data that is not yours or run availability
tests against systems you do not operate.

## Deployment boundaries

The local appliance is single-owner but authenticated. It binds to loopback by
default, issues a hashed and expiring one-time bootstrap token, stores only
hashed session tokens, and keeps PostgreSQL on a Unix socket. Local provider
PAT and BYOK credentials are
encrypted with a volume-owned root key stored with mode `0600`. Local telemetry
is redacted stdout/stderr only.

SaaS requires Clerk workspace membership on every resource boundary. GitHub App
and provider OAuth identities are the preferred source-provider credentials;
workspace administrators can also submit provider PATs when organization policy
prevents application authorization. Hosted BYOK model keys remain unsupported.
OAuth state is signed, one-time, exact-callback-bound, and PKCE-protected.
Webhook signatures are checked before parsing and delivery IDs are deduplicated.

SaaS OAuth tokens, provider PATs, managed-model credentials, and AI transcripts
use AES-256-GCM with workspace/record/provider additional authenticated data. A
shared 256-bit root stored as a Vercel Sensitive Environment Variable derives an
isolated key for each workspace. The root is never stored in the database or
exposed to the browser. Losing or replacing it makes existing encrypted records
unreadable, so operators must retain it in protected recovery material and must
not rotate it without a re-encryption procedure.

Private source objects are workspace-addressed. UploadThing identifiers contain
an HMAC rather than tenant or repository metadata. Signed URLs are issued only
after workspace, repository, revision, and path authorization, expire after 60
seconds for browsers, and are prohibited from durable state, logs, Sentry,
transcripts, and browser storage.

Provider and configurable model URLs pass DNS-pinned SSRF validation and do not
follow redirects. The local target may explicitly allow loopback and private
network providers, while cloud-metadata and link-local targets remain blocked.
AI tools are read-only
and job-scoped, with no shell, arbitrary filesystem, general network, or
credential access. Repository content is untrusted prompt input. Big Pickle
filters protected paths and high-confidence secrets before transmission.
OpenRouter requests require Zero Data Retention and fail closed.

Sentry sends no default PII. Source, prompts, output, credentials, OAuth data,
storage identifiers, signed URLs, repository paths, request bodies, cookies,
and authorization headers are redacted.

Current CI gates include unit tests, focused PostgreSQL integration tests,
dependency audit, migration drift, both deployment builds, an offline amd64
appliance journey, browser bootstrap/session coverage, backup archive
verification, SBOM generation, image vulnerability scanning, build provenance,
and image signing for versioned releases. Release images are built for amd64
and arm64; the automated appliance journey currently runs on amd64.
