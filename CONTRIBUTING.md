# Contributing

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree to follow it.

Open an issue before undertaking a broad behavior or schema change. Keep pull
requests focused, preserve the language-parser folder boundary, and include
tests at the layer where behavior is owned.

Use Node.js 24 and the pinned pnpm version, then run:

```bash
make install
make check
pnpm audit:prod
make build
```

Schema changes also need a generated migration and the PostgreSQL integration
suite. The same checks run in CI against PostgreSQL 18 and both deployment
targets.

Database lifecycle, authorization, concurrency, quota, and retry changes need a
PostgreSQL-backed integration test. Do not include credentials, private source,
generated design explorations, or unrelated formatting in a change. By
contributing, you agree that your contribution is licensed under AGPL-3.0-only.

Report security issues through the private process in `SECURITY.md`.
