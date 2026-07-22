# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security-advisory reporting flow for this repository. Include the affected
version, deployment mode, reproduction steps, impact, and any suggested fix.
Please do not access data that is not yours or run availability tests against
systems you do not operate.

The maintainers aim to acknowledge a complete report within three business
days, provide an initial assessment within seven, and coordinate disclosure
after a fix is available. Supported releases receive security fixes; untagged
development builds do not carry a compatibility guarantee.

## Deployment boundary

Local mode is an unauthenticated, single-user service and must remain bound to
loopback. Authenticated mode requires Clerk and workspace-scoped authorization.
Private provider hosts are denied unless the operator explicitly enables them.

Credentials are encrypted with AES-256-GCM. Ciphertexts contain a key ID;
operators rotate by setting a new `ENCRYPTION_KEY_ID` and `ENCRYPTION_KEY` and
temporarily retaining old ID-to-key entries in `ENCRYPTION_PREVIOUS_KEYS`.
Operators should source these keys from a suitable secret manager. A
multi-tenant installation should replace the environment keyring with KMS-backed
envelope encryption and per-tenant data-encryption keys.

Dependencies are audited at moderate severity in CI. Container builds are
scanned, emit an SBOM and provenance, and are signed keylessly with Sigstore.
