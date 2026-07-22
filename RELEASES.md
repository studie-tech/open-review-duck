# Release policy

Releases use semantic versioning and immutable `vMAJOR.MINOR.PATCH` tags. The
container workflow publishes the tag and digest, attaches build provenance and
an SBOM, scans the image, and signs the digest with Sigstore keyless signing.
Consumers should pin a digest for production use and verify the signature.

Security fixes are backported to the latest supported major release when
practical. Breaking configuration, schema, or API changes require a major
release and migration notes. Every release must pass unit tests, PostgreSQL
integration tests, production dependency audit, container scan, agent build,
and application build.
