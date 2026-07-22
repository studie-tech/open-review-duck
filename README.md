<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/reviewduck-readme-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./public/reviewduck-readme-light.svg" />
    <img src="./public/reviewduck-readme-light.svg" width="100%" alt="ReviewDuck.ai — For those of us who still have to review all the AI slop." />
  </picture>
</p>

AI can produce more code, faster than ever. Someone still has to understand
that code well enough to approve it—and that work deserves something better
than an ever-growing wall of diffs.

ReviewDuck is a human-centered pull-request review workspace for GitHub,
GitLab, and Azure DevOps. It turns a change into logical, dependency-aware
review units and guides you from foundational data models, constants, and
utilities toward the orchestration and feature logic built on top of them.
Language-aware analysis is available for JavaScript, TypeScript, Python, Java,
C#, C++, C, PHP, Shell, Ruby, HCL, Rust, Lua, Go, Makefiles, and Kotlin. Files
without a dedicated parser are still included as whole-file review units, while
binary changes are clearly identified so nothing quietly disappears from the
review.

Every sign-off records the reviewed unit's semantic fingerprint. When a pull
request changes again, ReviewDuck keeps the sign-offs that are still valid and
brings changed units—and the callers affected by them—back for attention. You
can keep pace with an active pull request without starting the review over or
trusting stale understanding.

AI is there to support your judgment, not replace it. On demand, it can explain
specific parts of the code and surface evidence-backed findings inside a
scoped workspace. Connect OpenAI, Anthropic, Azure OpenAI, Google AI,
OpenRouter, Mistral, Ollama, OpenCode Zen, or a custom compatible endpoint.

Try ReviewDuck free at [reviewduck.ai](https://reviewduck.ai), or run it locally
with the quickstart below.

## Local quickstart

Run the self-contained image, keeping both the application and its encrypted
credentials on a named Docker volume:

```bash
docker run -d \
  --name reviewduck \
  --restart unless-stopped \
  -p 127.0.0.1:3666:3666 \
  -v reviewduck-data:/data \
  ghcr.io/studie-tech/reviewduck:latest
```

Open [http://localhost:3666](http://localhost:3666), connect GitHub, GitLab, or
Azure DevOps with a personal access token, select a pull request, and start
reviewing. Local mode has one trusted user and needs no Clerk account, external
database, Node.js installation, or application secrets. PostgreSQL, schema
migrations, and the AI runtime are managed inside the container. The named
volume preserves reviews, tokens, model keys, and encryption secrets across
container replacement.

The port is deliberately bound to `127.0.0.1`; keep that binding because local
mode has no login screen. ReviewDuck also rejects non-loopback Host headers to
reduce browser DNS-rebinding exposure, but that check is not a substitute for
the network binding. To upgrade without losing data:

```bash
docker pull ghcr.io/studie-tech/reviewduck:latest
docker stop reviewduck
docker rm reviewduck
docker run -d --name reviewduck --restart unless-stopped \
  -p 127.0.0.1:3666:3666 -v reviewduck-data:/data \
  ghcr.io/studie-tech/reviewduck:latest
```

AI remains optional. In local mode, OpenCode Zen and its `big-pickle` model are
preselected to minimize setup cost, but ReviewDuck does not bundle the model or
an OpenCode credential. Big Pickle is a stealth model that OpenCode currently
offers free only for a limited period, and code submitted during that period
may be collected to improve the model. Review the current
[OpenCode Zen pricing and privacy terms](https://opencode.ai/docs/zen), paste
your own Zen key, and pass ReviewDuck's model workflow test before enabling it.
Choose another supported provider for confidential code when those terms are
not appropriate.

## Stack

- Next.js 16 App Router, React 19, native TypeScript 7, tRPC 11
- Biome 2 for compiler-independent formatting, linting, and Drizzle safety rules
- Tailwind CSS 4 and reusable `src/components/ui` primitives
- Drizzle ORM 0.45 with PostgreSQL
- Explicit local single-user mode or Clerk-authenticated multi-user mode
- Flue 1.0 beta agent runtime for isolated AI assistance
- An extensible language-parser registry with dedicated review-unit extraction
  for JavaScript, TypeScript, Python, Java, C#, C++, C, PHP, Shell, Ruby, HCL,
  Rust, Lua, Go, Makefiles, and Kotlin
- Vitest for analysis, provider normalization, and security tests

The repository uses root-level Drizzle schema and migrations, explicit feature
routers, dedicated validators, shared UI primitives, and focused services for
analysis, provider access, retention, security, exports, and AI execution.

## Project structure

```text
.
├── .flue/
│   ├── agents/code-reviewer.ts  # scoped Flue review agent
│   └── app.ts                   # standalone agent HTTP service
├── drizzle/
│   ├── schema.ts
│   └── 000*_*.sql
├── src/
│   ├── app/                     # pages, tRPC endpoint, auth lifecycle route
│   ├── components/
│   │   ├── review/
│   │   ├── settings/
│   │   └── ui/
│   ├── server/
│   │   ├── ai/
│   │   ├── analysis/
│   │   ├── api/routers/
│   │   ├── providers/
│   │   └── sync/
│   └── validators/
└── flue.config.ts
```

## Source development setup

Requirements: Node.js 24 or newer, Corepack/pnpm, and PostgreSQL. Set
`DEPLOYMENT_MODE=local` to develop with the trusted local identity. The
repository pins pnpm in `package.json`.

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
make start
```

`make start` runs both the web application on `http://localhost:3666` and the
local AI service on `http://localhost:3100`. It verifies database connectivity
before launching either process, and both processes stop together. For local
development, they share the configured `DATABASE_URL`. The AI service can use a
dedicated `FLUE_DATABASE_URL` when needed.

Override either port when needed:

```bash
make start PORT=4000 AGENT_PORT=3101
```

### Database configuration

Set `DATABASE_URL` for application queries and `MIGRATION_DATABASE_URL` for
schema migrations. Apply committed migrations with:

```bash
pnpm db:migrate
```

Create schema changes with `pnpm db:generate`; never use `db:push` against
production.

### Provider synchronization

ReviewDuck polls provider APIs while a review is open and also offers explicit
refresh controls. This keeps local development functional
without exposing localhost through a tunnel or requiring webhook configuration.

## Verification

TypeScript 7's stable `tsc` is the authoritative type checker. Next.js 16.2
still detects the native compiler through `@typescript/native-preview`, so that
compatibility package remains installed until Next.js recognizes the stable
TypeScript 7 package layout directly. CI always runs `pnpm typecheck` before the
production build.

```bash
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm format:check
pnpm db:generate
pnpm build:agent
pnpm build
```

CI may set `SKIP_ENV_VALIDATION=1` for compilation-only builds, but running
environments must never skip validation.

## Security model

- Provider and BYOK credentials use AES-256-GCM with a server-owned encryption
  key.
- Provider base URLs resolve to public HTTPS hosts by default to prevent SSRF.
  Trusted private Git servers require the explicit
  `ALLOW_PRIVATE_PROVIDER_HOSTS=true` opt-in.
- BYOK model base URLs receive the same protection. Local or private
  Ollama-compatible endpoints require `ALLOW_PRIVATE_AI_HOSTS=true` on a
  trusted private deployment.
- Every tRPC resource query joins through workspace membership.
- The Flue agent receives job-scoped read tools, not provider credentials or
  unrestricted repository access.
- Repository content is explicitly treated as untrusted prompt input.
- Provider and BYOK traffic resolves and pins the vetted address used by the
  real socket while preserving the original TLS hostname.
- Source-bearing snapshots are retained for at most 30 days and five snapshots
  per pull request by default. Both boundaries are configurable.

See [Security](./SECURITY.md), [Privacy and retention](./docs/PRIVACY.md), and
[Third-party notices](./THIRD_PARTY_NOTICES.md) for the operational policies.

## License

ReviewDuck is licensed under the
[GNU Affero General Public License v3.0](./LICENSE), version 3 only.

Commercial licenses with alternative terms may be offered separately by the
copyright holders. Contact the maintainers if AGPL-3.0 does not fit your
distribution requirements.

Contributions follow [CONTRIBUTING.md](./CONTRIBUTING.md). Support and release
expectations are documented in [SUPPORT.md](./SUPPORT.md) and
[RELEASES.md](./RELEASES.md).
