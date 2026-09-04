# Release policy

Releases use semantic versioning and immutable `vMAJOR.MINOR.PATCH` tags. The
container workflow publishes the tag and digest, attaches build provenance and
an SBOM, scans the image, and signs the digest with Sigstore keyless signing.
Consumers should pin a digest for production use and verify the signature.

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
