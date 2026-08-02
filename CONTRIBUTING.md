# Contributing

Open an issue before undertaking a broad behavior or schema change. Keep pull
requests focused, preserve the language-parser folder boundary, and include
tests at the layer where behavior is owned.

Use Node.js 24 and the pinned pnpm version, then run:

```bash
pnpm install
pnpm check
pnpm test:coverage
pnpm audit:prod
pnpm db:generate
pnpm build:agent
pnpm build
```

Database lifecycle, authorization, concurrency, quota, and retry changes need a
PostgreSQL-backed integration test. Do not include credentials, private source,
generated design explorations, or unrelated formatting in a change. By
contributing, you agree that your contribution is licensed under AGPL-3.0-only.

Report security issues through the private process in `SECURITY.md`.
