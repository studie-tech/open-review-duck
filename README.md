<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/reviewduck-readme-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./public/reviewduck-readme-light.svg" />
    <img src="./public/reviewduck-readme-light.svg" width="100%" alt="ReviewDuck.ai — For those of us who still have to review all the AI slop." />
  </picture>
</p>

AI can produce code faster than most teams can review it. Someone still has to
understand the change well enough to approve it.

ReviewDuck helps you work through a pull request in dependency order. It groups
related edits into review units and starts with the code that other changes
depend on. Sign-offs survive new commits when the code you reviewed has not
changed, so an updated pull request does not send you back to the beginning.

It works with GitHub, GitLab, and Azure DevOps. You can comment, approve,
request changes, and keep the provider's review state in sync from the same
screen.

Use the hosted app at [reviewduck.ai](https://reviewduck.ai), or run the local
appliance below.

## Run ReviewDuck locally

The Docker image includes ReviewDuck, PostgreSQL 18, migrations, durable
workflows, Tree-sitter grammars, and private file storage. You do not need an
account, an `.env` file, or a separate database.

```bash
docker run --detach \
  --name open-review-duck \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v open-review-duck-data:/data \
  ghcr.io/studie-tech/open-review-duck:latest

docker logs --follow open-review-duck
```

The first boot prints a one-time owner link. Open that link within 15 minutes,
then go to [http://localhost:3000](http://localhost:3000). Your session, reviews,
credentials, source files, and backups stay in the Docker volume.

Keep the port bound to `127.0.0.1`. The local appliance is meant to run on the
same machine as your browser and rejects non-loopback hosts.

For a reproducible installation, replace `latest` with a version tag or image
digest from the [releases](https://github.com/studie-tech/open-review-duck/releases).

## Connect a code provider

Open Settings, add a connection, and follow the permission guide shown for your
provider. Local credentials are encrypted before they are written to the data
volume.

- GitHub needs a fine-grained token with read access to repository contents and
  read/write access to pull requests.
- GitLab needs an `api`-scoped personal, project, or group token. The token's
  identity must be allowed to approve merge requests if you want to approve
  them from ReviewDuck.
- Azure DevOps needs a token for one organization with Code read/write access.

After connecting a provider:

1. Choose which repositories ReviewDuck may access.
2. Pick an intake mode for each repository: manual, assigned to you, or every
   open pull request. ReviewDuck shows what will be added before automation is
   enabled.
3. Open a prepared pull request and follow its review path.
4. Sign off units as you understand them, leave comments where needed, then
   submit your provider review.

Completed work moves out of the active queue. Merged and closed pull requests
stay in history, and a pull request removed from your queue can be restored
later.

## How the review path works

Tree-sitter finds definitions, references, imports, tests, and structural
relationships. ReviewDuck uses those links to place foundational changes before
the code that depends on them. Related edits and removals can appear together
when the relationship is clear enough.

There are 62 bundled language grammars, including SQL. The current list lives in
[`tree-sitter-languages.json`](./tree-sitter-languages.json). Grammars load only
when a file needs them, and browser parsing runs in a worker so large diffs do
not block the review screen.

If an exact-revision SCIP index is available, ReviewDuck uses it to improve
definition and reference links. It never applies semantic data from another
revision.

## AI assistance

AI is optional. Ordinary reviews, comments, sign-offs, and provider decisions
work without it.

The assistant can answer a question about the current review unit or investigate
the whole pull request. It uses read-only, revision-bound tools and records the
files and source ranges used for its answer. Long investigations may use up to
64 model steps, with additional limits on time, source volume, tool calls, and
cost.

Local installations can use Ollama, a local OpenAI-compatible server, or a
supported provider with your own key. Those settings and credentials remain
encrypted on the local volume.

Big Pickle is also available as an optional free model. Before the first request,
ReviewDuck explains that selected source and prompts are sent to OpenCode's US
infrastructure and may be used for model improvement. It stays off until you
accept that disclosure. If the free model becomes unavailable or requires an
account, ReviewDuck disables it instead of selecting a paid model.

## Back up and upgrade

The appliance provides a small set of administration commands:

```bash
# Check the application, database, worker, disk, and migration state
docker exec open-review-duck reviewduck-local admin status

# Revoke local sessions and print a new one-time owner link
docker exec open-review-duck reviewduck-local admin bootstrap

# Create and verify a database backup
docker exec open-review-duck reviewduck-local admin backup
docker exec open-review-duck reviewduck-local admin verify-backup

# Export review records as JSON
docker exec open-review-duck reviewduck-local admin export
```

When a new image contains schema changes, ReviewDuck creates and verifies a
backup before applying them. The three most recent automatic upgrade backups
are kept in the data volume.

To restore a backup, stop the appliance and run the same image in administration
mode:

```bash
docker stop open-review-duck
docker run --rm --volumes-from open-review-duck \
  ghcr.io/studie-tech/open-review-duck:latest \
  admin restore /data/backups/<backup>.dump
docker start open-review-duck
```

## Develop ReviewDuck

You need Node.js 24 or newer, Corepack with the repository-pinned pnpm version,
Git, and Docker. Local development does not need an `.env` file.

```bash
make install
make start
```

`make start` starts PostgreSQL 18, applies migrations, prepares the grammar
assets, creates the local owner, and runs the app at
[http://localhost:3666](http://localhost:3666). Development state is kept in
the ignored `.reviewduck-dev` directory.

Common commands:

```bash
make bootstrap   # print a fresh one-time owner link
make stop        # stop the development database
make check       # run formatting, linting, type checking, and tests
make build       # create a production build
make migrations  # generate a Drizzle migration after a schema change
```

Set `PORT` or `DEV_DATABASE_PORT` if the defaults are already in use. To use an
existing PostgreSQL 18 database:

```bash
make start DEV_DATABASE_MANAGED=0 \
  DEV_DATABASE_URL=postgresql://user:password@localhost:5432/reviewduck
```

Run `pnpm db:migrate` to apply committed migrations and `pnpm db:generate` to
create a migration. Do not use schema push against a shared database.

## Host the SaaS build

The hosted target is designed for Vercel with PlanetScale PostgreSQL,
UploadThing private storage, Clerk, Vercel Workflows, AWS KMS, and Sentry. It
uses GitHub App installations, GitLab OAuth, and Microsoft Entra OAuth, so SaaS
users never paste provider tokens into ReviewDuck.

The required variables and short explanations are in
[`.env.example`](./.env.example). Production configuration fails closed when a
required credential, paid-model allowlist, spending limit, or privacy control
is missing.

## Releases and support

Releases follow semantic versioning. Tagged builds publish signed amd64 and
arm64 images with an SBOM and build provenance. See the
[release policy](./RELEASES.md) for verification and pinning details.

Please use GitHub Issues for reproducible bugs and focused feature requests.
Security reports should follow [SECURITY.md](./SECURITY.md).

More information:

- [Privacy and retention](./docs/PRIVACY.md)
- [Contributing](./CONTRIBUTING.md)
- [Support](./SUPPORT.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

## License

ReviewDuck is licensed under the
[GNU Affero General Public License v3.0](./LICENSE), version 3 only. Commercial
licenses with alternative terms may be offered separately.
