# Deep Review: a fan-out PR reviewer with OCR parity

Status: **implemented and validated against a live pull request.** The design
below is what shipped; §15 records what running it changed.

This plan describes a new ReviewDuck reviewer — "deep review" — that reaches feature
parity with [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
("OCR", Apache-2.0) while keeping ReviewDuck's architecture: no git clone, source over
the provider REST APIs, the existing durable workflow, and the workspace's configured
OpenRouter model.

Every claim about existing ReviewDuck behaviour below was verified against source at the
cited line. Every claim about OCR was verified against a pinned checkout of its `main`
branch, not its README.

---

## 1. What we are copying, and why

OCR's headline claim is higher precision and F1 than a general-purpose agent at roughly
one-ninth the tokens. Reading the source, that comes from five specific decisions. These
are the parity targets:

| # | OCR mechanism | Where | Why it matters |
|---|---|---|---|
| 1 | **One agent per changed file**, not one agent per PR | `internal/agent/agent.go` dispatches a goroutine per `model.Diff` | Each agent's context is one file's diff plus what it chooses to read. Token cost scales linearly and attention does not degrade across a 40-file PR. |
| 2 | **The model never reports line numbers** | `internal/tool/code_comment.go:88-124` — the tool schema has no line fields | Models are unreliable at line arithmetic. OCR asks for a verbatim `existing_code` snippet and derives lines deterministically. |
| 3 | **Per-language rulebooks injected by path glob** | `internal/config/rules/` | A Go agent gets goroutine/nil-deref rules; a Terraform agent gets state/secret rules. Generic "look for bugs" underperforms a checklist. |
| 4 | **A severity-biased pre-pass on large files** | `PLAN_TASK`, gated by changed-line count | Recall mechanism. Directs attention before the main pass. |
| 5 | **A filter pass that discards weak findings** | `REVIEW_FILTER_TASK` | Precision mechanism. Runs after collection, over a deliberately minimized view of each finding. |

Two things we deliberately **do not** copy:

- **OCR's first-match-wins anchoring.** `internal/diff/resolver.go:151-168` returns the
  first consecutive match with no ambiguity detection (its own test asserts this
  behaviour). A snippet appearing twice in a file anchors to the wrong one silently. We
  collect all matches and disambiguate.
- **OCR's prompt hygiene.** Its system prompts contain no untrusted-data framing —
  `grep -ri untrusted internal/config/template/prompts/` returns nothing. ReviewDuck's
  `src/config/prompts.ts:47` already treats PR metadata and source as untrusted and
  forbids following instructions found in them. That contract extends to every new
  prompt here; see §9.

We also add one thing OCR **structurally cannot** produce: cross-file findings. OCR's
system prompt says findings from other files must not become comments, and its loop
hard-overwrites the comment path to the file under review. A whole-PR survey agent
(§6.9) covers that class for one extra agent per run.

---

## 2. Architecture: Sealed Fan-Out Review

```
ai.start({ kind: "review" })          ← unchanged tRPC contract
        │
        ▼
   parent ai_job  kind="review", unitId=null
        │           (holds the ONLY quota reservation for the whole run)
        ▼
┌─────────────────────────────────────────────────────────────┐
│ pullRequestReviewWorkflow          (new durable workflow)    │
│                                                              │
│  step 1  seal-plan ──── freezes the coverage denominator     │
│            │            creates every ai_review_item +       │
│            │            every child ai_job, in one tx        │
│            ▼                                                 │
│  step 2   ALL file agents dispatched at once (no batching)   │
│            │   child ai_job kind="review_file", one per file │
│            │     ├─ plan                                      │
│            │     ├─ scout turns  → report_finding tool        │
│            │     ├─ anchor + relocate                         │
│            │     ├─ scope + evidence gates                    │
│            │     └─ refute (one batched call per file)        │
│            ▼                                                 │
│  step 3   survey ────── one whole-PR agent, cross-file class  │
│            ▼                                                 │
│  step 4   dedupe ────── deterministic collapse, then LLM      │
│            ▼                                                 │
│  step 5   finalize ──── sweep coverage, roll usage up to the  │
│                         parent, settle quota, publish result  │
└─────────────────────────────────────────────────────────────┘
```

Three load-bearing invariants:

**I1 — The parent's identity never changes.** It stays `kind: "review"`, `unitId: null`.
`ai.reviewStatus` (`src/server/api/routers/ai.ts`) and `review.unitDiscussion`
(`src/server/api/routers/review.ts`) both hardcode that exact pair. Keeping it means
those predicates are untouched. Only *children* get new kind values.

**I2 — `executeAiTurn` is not modified.** Explain, question and streaming all run
through it. We add `executeReviewFileTurn` beside it and select the workflow at the one
dispatch site (`src/server/workflows/service.ts:202`). Existing flows execute zero new
code — isolation by construction, not by care.

**I3 — Coverage is sealed before concurrency exists.** Every file that will be reviewed
gets a row before any agent starts. A run can then report `complete` / `partial` /
`failed` / `skipped` truthfully, because the denominator cannot move. This is OCR's
`SealSelected` (`internal/session/manifest.go`) expressed as rows instead of a JSONL
replay log.

---

## 3. Data model

**Greenfield: `drizzle/schema.ts` is authoritative and the migration set is regenerated
from scratch.** There are no users and no data worth preserving, so we do not write
incremental migrations, do not append enum values, and do not carry a compatibility
discriminator. Delete `drizzle/*.sql` and the journal, edit `schema.ts` to its final
shape, and run `pnpm db:generate` once to produce a fresh baseline.

This removes a hazard rather than deferring one: an incremental design would have needed
`ALTER TYPE ... ADD VALUE` split into its own migration file, because `scripts/migrate.mjs`
runs `migrate()` from `drizzle-orm/node-postgres/migrator`, which wraps pending migrations
in a transaction, and PostgreSQL forbids *using* an enum value added in the same
transaction. Regenerating from scratch means the enums are simply declared with their
final values and the constraint never arises.

### 3.1 Enums, declared final

```ts
export const aiJobKindEnum = pgEnum("ai_job_kind", [
  "explain",
  "review",          // the deep-review parent
  "review_file",     // one child per changed file
  "review_survey",   // the single whole-PR child
  "semantic_cluster",
]);
```

`ai_completion_reason` gains `deep_review_partial` and `deep_review_skipped` alongside its
existing six (`answered | investigation_limit | quota_limit | cost_limit | cancelled |
provider_failure`).

**Findings adopt OCR's taxonomy wholesale**, replacing ReviewDuck's three-value severity.
The vendored rulebooks are written against this vocabulary — they say things like "report
as `security`, severity `high`" — so storing anything else would require a lossy
translation layer between what a rulebook instructs and what we persist:

```ts
export const findingSeverityEnum = pgEnum("finding_severity", [
  "critical", "high", "medium", "low",
]);
export const findingCategoryEnum = pgEnum("finding_category", [
  "bug", "security", "performance", "maintainability",
  "test", "style", "documentation", "other",
]);
```

Both mirror `internal/tool/code_comment.go:16-46` exactly. Copy OCR's normalization
discipline with them (`code_comment.go:127-141`): an unrecognized category degrades to
`other` and an unrecognized severity to `low`, rather than rejecting the finding. A model
that invents `"blocker"` should still have its finding surfaced, conservatively ranked.

This is a wider change than severity alone, and the full surface is:

- `src/validators/ai.ts:139` — `severity: z.enum(["info","warning","critical"])` becomes the
  four-value enum, and `category` is added. Note the legacy `explain`/question paths share
  `aiResultSchema`; they return empty `findings` arrays, so widening the enum does not
  affect them.
- The `report_finding` tool schema (§6.5) and the survey's variant.
- `findings.ts` severity ranking for `orderIndex` (§6.11): `critical > high > medium > low`.
- The UI gains category as a filter dimension — the main way a reviewer triages a
  40-finding run is "show me security only" (§7).

### 3.2 `ai_job`

**Two new columns. There is no `deepReview` flag.** An earlier draft carried one to
distinguish new deep-review parents from legacy single-agent reviews during a drain — but
the old reviewer is deleted in the same change (§6.1b), so `kind: "review"` *is* the
discriminator, and a boolean that is always `true` for every row of that kind is exactly
the kind of vestigial column a cleanfield rebuild exists to avoid.

```ts
parentJobId: uuid().references(() => aiJobs.id, { onDelete: "cascade" }),
ruleConfigDigest: varchar({ length: 64 }).notNull(),
```

`startAiJob` (`src/server/workflows/service.ts:156`) receives only a job id, but `job` is
already in scope inside its transaction, so the dispatch branches on kind:

```ts
run = await start(
  job.kind === "review" ? pullRequestReviewWorkflow : aiJobWorkflow,
  [jobId],
);
```

Child kinds (`review_file`, `review_survey`) never reach this call site — they are executed
as steps of the parent's workflow, not dispatched independently.

**`ai_review_item`** — the sealed coverage denominator, one row per selected file:

```ts
id, parentJobId (fk cascade), workspaceId (fk), childJobId (fk, null for waived/reused),
path text notNull, changeType, changedLineCount integer notNull,
state: deepReviewItemStateEnum notNull,     // selected | completed | reused | failed | waived
failureClass: reviewFailureClassEnum,        // provider | timeout | budget | cancelled | tool_limit | unknown
reason text,                                 // sanitizeReason'd, never raw
fingerprint varchar(64) notNull,
createdAt, updatedAt
// uniqueIndex(parentJobId, path); index(workspaceId, fingerprint)
```

Note `skipped` is **not** an item state. The budget path marks items `failed(budget)`;
using two vocabularies for one transition invites a sixth enum value later.

**`ai_review_finding`** — one row per reported finding, never deleted:

```ts
id, itemId (fk cascade), jobId (fk, the child that produced it), workspaceId (fk),
path text,                                   // NULLABLE — survey findings may have none
severity: findingSeverityEnum().notNull(),
category: findingCategoryEnum().notNull(),
encryptedContent text notNull,               // vault-sealed {title, body, existingCode, suggestionCode}
state: deepReviewFindingStateEnum notNull,   // submitted | anchored | unanchored | out_of_scope
                                             // | ungrounded | refuted | merged | dropped
verdict: deepReviewVerdictEnum,              // unverified | not_refuted | refuted
verdictReason text,
anchorTier, anchorSide, startLine, endLine, anchorAmbiguous boolean,
unitId (fk, null when no unit contains the anchor),
mergedIntoId (self fk), orderIndex integer,
createdAt
```

Two corrections to the obvious design, both from the critique pass:

- **`path` must be nullable.** The survey agent's whole purpose is cross-file findings
  that may not name a single file. A `notNull` path makes the headline recall class
  unstorable. Survey findings additionally carry an `ai_review_finding_location` child
  table (`findingId, path, existingCode, startLine, endLine`) so each location anchors
  independently and the finding surfaces on the first that resolves.
- **Content must be vault-sealed.** Every column in this schema holding model-visible
  repository content is sealed: `ai_job_turn.encryptedContent`,
  `ai_job_tool_call.encryptedInput/encryptedOutput`, `ai_job_chunk.encryptedContent`,
  `local_ai_configuration.encryptedConfiguration`. `ai_job_evidence` deliberately stores
  only paths, digests and byte offsets. Storing a finding's `existingCode` — a verbatim
  source excerpt — as plaintext would be the first exception, and would do it in the one
  table designed to be retained longest. Seal with
  `sealVaultSecret({ workspaceId, recordId: findingId, provider: "ai-review-finding" })`.
  This is why `workspaceId` is denormalized onto both new tables.

**`ai_review_finding_evidence`** — join rows proving the agent actually read the bytes it
commented on: `findingId, evidenceId (fk ai_job_evidence)`.

---

## 4. Module layout

All new server code under `src/server/review/deep/`. Pure, testable modules first;
everything touching the model or the DB depends on them, not the reverse.

| Path | Purpose |
|---|---|
| `selection.ts` | **Pure.** Which files get reviewed, and why not. Ports OCR's exclusion ladder. |
| `rulebooks.ts` | **Pure.** Path glob → rulebook resolution over the vendored corpus. |
| `anchor.ts` | **Pure.** The tiered snippet→line resolver. The most important module here. |
| `coverage.ts` | **Pure.** Terminal-state algebra and the partition assertion. |
| `findings.ts` | **Pure.** Finding id derivation, normalization, severity mapping, ordering. |
| `redaction.ts` | **Pure.** `sanitizeReason` — the redaction floor for anything persisted from a provider error. |
| `dedupe.ts` | Deterministic collapse + the guarded LLM cluster call. |
| `refute-policy.ts` | **Pure.** Verdict validation: duplicate ids, unknown ids, unverifiable `evidencePath`. |
| `review-prompts.ts` | Every prompt string for the five new model calls. |
| `context.ts` | Builds **one** `RepositoryContext` for the whole run, shared by every child. |
| `plan.ts` | Seals the coverage denominator; creates items and child jobs. |
| `file-agent.ts` | `executeReviewFileTurn` — one durable model turn for one file. |
| `file-tools.ts` | The child agent's tools, including `report_finding`. |
| `validate.ts` | Anchor → relocate → scope gate → evidence gate → refute, per file. |
| `survey.ts` | The whole-PR cross-file agent, its distinct tool schema and evidence exemption. |
| `finalize.ts` | Coverage sweep, usage rollup, projection, settle. |
| `cancel.ts` | Terminal sweep of a cancelled tree. |

New workflow: `src/server/workflows/pull-request-review.ts`.
Vendored assets: `src/server/review/deep/rulebooks/` (see §8).

Every module gets a co-located `*.test.ts`. House style, verified across
`src/server/ai/*.ts`: a one-line `/** ... */` docstring on every exported and
module-level function, written as a statement of purpose in the present tense
("Resolves one job-scoped model without exposing credentials to Workflow state."),
enforced by `pnpm docstrings:check`.

---

## 5. Selection: which files get reviewed

Ported from OCR's exclusion ladder, evaluated in this order. Every exclusion is
**recorded as a waived item with a reason**, never silently dropped — an improvement over
both OCR and ReviewDuck's current behaviour.

```ts
type ReviewExcludeReason =
  | "binary" | "no_source" | "generated" | "vendored" | "unsupported_extension"
  | "oversized" | "protected_path" | "secret_detected";
```

`protected_path` and `secret_detected` come from `src/server/ai/source-policy.ts` and are
**mandatory**, not optional. Deep review is enabled when `subscribed || isLocalDeployment()`,
and on a local appliance the default provider is OpenCode Zen ("big pickle"). Today
`executeAiTurn` filters every unit through `bigPickleIgnoreMatcher` and
`bigPickleSourceDecision` before building the prompt (`src/server/ai/agent-loop.ts:330-366`)
and re-applies the check inside `list_files`. A new prompt path that skips those checks
would route source through the free tier that today's path refuses. Evaluate them in
`sealReviewPlan`, where source is already hydrated.

`sourceBytes` for the oversize check comes from `source_blob.byteLength` joined via
`snapshot_file.currentBlobId` — `snapshot_file` itself has no byte count. A null
`currentBlobId` is the `no_source` case.

**Deleted files are reviewed — confirmed.** A PR that removes a permission check, drops a
validation, or deletes the only caller of something load-bearing is exactly the PR that
needs review. OCR excludes deleted files (`ExcludeDeleted`); this is a deliberate
divergence and it makes `deleted` an invalid `ReviewExcludeReason`.

Concretely, a deleted file gets:
- a previous-revision-only prompt — there is no current source, so the scout reviews the
  removal itself and what the codebase still expects from it;
- `anchorSide: "previous"` and the `file_previous` anchor tier (§6.6), which is therefore
  live code rather than the dead branch it would be under OCR's exclusion;
- `side: "left"` on publish;
- full participation in the survey pass, which is where a deletion's real risk usually
  shows up — a removed export with surviving importers is a cross-file finding.

**Renames:** `snapshot_file.previousPath` exists but no provider populates it today —
GitHub reads `previous_filename` only to choose the base fetch ref
(`src/server/providers/github.ts`). Populate it in every provider as a prerequisite (§11). Dropping `RENAMED` from the prompts would be the shortcut; a rename is a
delete-plus-add that the reviewer should understand as one move, and the old path is what
makes that possible.

---

## 6. The pipeline

### 6.1 Trigger — entitlement, and a refusal

`ai.start({ pullRequestId, kind: "review" })`. `startAiJobSchema`'s strict review branch
and the existing rate limit are untouched, and `createAiJob` gains no new input — a
`kind: "review"` job *is* a deep review, so entitlement is enforced by refusing to create
the job at all rather than by flagging it.

**Free-tier behaviour — decided: no review at all, and the old reviewer is scrapped.**
Deep review is not an upgrade over today's single-agent reviewer; it *replaces* it. There
is exactly one PR reviewer after this lands, and unentitled SaaS users do not get it.

That makes entitlement a **refusal**, not a fallthrough. Three gates, in depth order:

1. **`ai.configuration` gains `deepReviewAvailable: boolean`** (`subscribed || isLocalDeployment()`).
   This is what the UI reads.
2. **The client stops asking.** Both entry points must check it: the Review button, and —
   easy to miss — the auto-start `useEffect` at
   `src/components/review/review-workspace.tsx:2418-2440`, which fires
   `ai.start({ kind: "review" })` on page load whenever `reviewPullRequests` is on and
   `mode !== "off"`. **The "automatic" review trigger is client-side; there is no
   server-side one.** Without this gate every unentitled user with the preference enabled
   gets a failed mutation on every pull-request page load.
3. **`ai.start` refuses** as the backstop, throwing `"Deep review requires a paid plan"`.
   This one *does* need adding to `safeAiStartMessages`
   (`src/server/api/routers/ai.ts:69-82`, currently 12 entries) — otherwise it is laundered
   into the generic "Could not start the AI assistant. Try again." Match the existing
   style: short, sentence case, no trailing period.

The entitlement is read **once, at `ai.start`**, and never again. A job that exists is a
job that runs: nothing inside the workflow re-checks entitlement, so a subscription lapsing
mid-run cannot strand a sealed plan with no reviewer willing to execute it.

The reason a free tier cannot fund a fan-out: `managedInvestigationReservation` caps a
review reservation at 80% of the monthly limit (`src/server/ai/turn-guards.ts:34`), and
`MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT` defaults to 100,000 (`src/env.js:68`). The entire
free monthly allowance is ~80k tokens for one review. Paid is 5,000,000 (`src/env.js:73`).

Note this removes PR review from the free tier as a product capability, not just as an
implementation. Free users keep `explain` and question threads, which are per-unit and
funded comfortably by 100k tokens/month. Worth confirming that is the intended offer.

### 6.1a The local appliance — decided: deep review runs there

**The gate is `subscribed || isLocalDeployment()`.** Writing it as `subscribed` alone would
have turned deep review permanently off on the entire open-source appliance, silently, via
a line written for a different purpose — so the disjunction is load-bearing and needs the
comment below to survive future cleanup.

The trap: **`subscribed` is forced to `false` on local deployments**
(`src/server/ai/service.ts:131`):

```ts
const local = isLocalDeployment();
const subscribed = !local && input.subscribed;
```

`subscribed` is derived from a Clerk entitlement (`ctx.auth.has({ feature: PAID_AI_FEATURE })`),
and there is no Clerk on local.

The rationale for including local: self-hosted users configure their own provider and pay
their own bills directly — `useManagedQuota` is `!local` (`src/server/ai/service.ts:155`),
so there is no ReviewDuck-borne cost to protect. The paid gate is about SaaS economics,
and the appliance has none. Deep review is therefore paid-only *on the hosted product*,
and available to everyone running the appliance.

Write it with the reason attached, because the disjunction looks redundant at a glance:

```ts
// `subscribed` is forced false on local (service.ts:131), where quota is not managed
// and the operator pays their own provider. Paid-only applies to the hosted plan.
const deepReview = subscribed || isLocalDeployment();
```

The free-provider guards still apply on local: an OpenCode Zen ("big pickle") workspace
must pass `bigPickleSourceDecision` per file, and those exclusions become waived items with
a stated reason (§5).

### 6.1b Deleting the single-agent reviewer

Deleted in the same change that adds the replacement — no drain, no dual path, no
compatibility window. With the database rebuilt from scratch there are no legacy
`kind: "review"` rows to strand, so the two-release retirement an incremental rollout
would have required is simply not needed.

Removal surface, verified:

- `src/config/prompts.ts:116-128` — the entire `review` instruction block. The `jobKind`
  union on `reviewDuckAgentPrompt` narrows from `"explain" | "review"` to `"explain"`,
  which makes the whole `configuration.jobKind === "review"` ternary at
  `src/config/prompts.ts:132` collapse.
- `src/server/ai/agent-loop.ts:384` — the sole `reviewDuckAgentPrompt` call site; its
  `jobKind` argument becomes constant.
- The review-specific result handling in `acceptAiJobResult` that has no explain analogue.
- Any `kind === "review"` branch inside `executeAiTurn`'s scoping (review jobs hydrate
  every unit; explain jobs hydrate one).

`explain`, question threads and `semantic_cluster` are untouched — they are the other
consumers of `executeAiTurn`, and invariant **I2** is what keeps them that way. Deleting
the review branch *narrows* that function rather than changing it for the remaining
callers, which is the one kind of edit to it that carries no risk to those flows.

### 6.2 Seal plan — one transaction, no concurrency yet

Under `pg_advisory_xact_lock(hashtext('deep-review:plan:' || parentJobId))`, every insert
`.onConflictDoNothing()` on its unique index so replay is free.

**Do not call `createAiJob` for children.** It opens its own transaction
(`src/server/ai/service.ts:349`), takes `db` rather than a transaction handle, and before
that transaction runs `jobScope` plus a full snapshot hydration. Children carry
`unitId: null`, so each call would re-hydrate the entire snapshot — ~25 full hydrations
for a 24-file PR, inside what is supposed to be one transaction, against a pool of
`max: 5` in production (`src/server/db/index.ts:20`) with a 20s query timeout.

Add `createReviewChildJob(tx, {...})` instead: a direct insert with `parentJobId`, zero
reservations, no dedupe lock, no `jobScope`, and **`workspaceId`, `pullRequestId`,
`snapshotId`, `userId`, `model` and `provider` copied from the parent row**. Copying
`snapshotId` is not cosmetic: `jobScope` selects the newest snapshot by version
(`src/server/ai/service.ts:90-158`), so a webhook-driven re-sync mid-run would otherwise
split one review across two revisions.

This step also writes `status: "running"` and `startedAt: new Date()` on the parent.
Today those are written only by `executeAiTurn` (`src/server/ai/agent-loop.ts:292-300`),
which this workflow never calls. Without them: the UI's poll predicate never fires so a
15-minute fan-out looks frozen, and the `AI_MAX_DURATION_MS` wall-clock check has no
anchor to measure against — `executeReviewFileTurn` must read the **parent's**
`startedAt`, or 24 files each get their own 30 minutes.

**Zero selected files** → terminal state `skipped`, a summary naming every exclusion
reason, quota settled. This cannot be an `ai.start` error: selection happens in the first
durable step, after the tRPC mutation has already resolved.

### 6.3 Reuse pass

Fingerprint: `sha256(workspaceId ∥ headSha ∥ path ∥ currentBlobDigest ∥ previousBlobDigest ∥ ruleConfigDigest)`.

`workspaceId` is **in the fingerprint and in the lookup predicate**. Without it one
workspace's findings are copied into another's run.

Cross-*user* reuse is not a question today: a workspace has exactly one member. The only
`insert(workspaceMembers)` in the codebase is `ensurePersonalWorkspace`
(`src/server/workspaces/service.ts:71`), which adds the creating user to their own
personal workspace; there is no invite flow, no members router, and the Clerk webhook
handles no organization events. So `workspaceId` and `userId` are today equivalent keys,
and keying on `workspaceId` is the one that stays correct if sharing ships later.

### 6.4 File plan — large files only

OCR's `PLAN_TASK`, gated exactly as OCR gates it: only when the file's summed changed-line
count ≥ `DEEP_REVIEW_PLAN_LINE_THRESHOLD` (default 50). Stateless, no tools. Returns up to
5 `{ focus, lines, why }` checkpoints rendered into the scout prompt.

The threshold is kept deliberately, and it is parity rather than cost-cutting: a
severity-biased pre-pass over a three-line change has nothing to prioritise and its output
is noise the scout then has to discount. This is the one gate in the pipeline that survives
the no-shortcuts rule, because skipping it *improves* the result on small files.

On any failure, substitute the literal sentinel `(no pre-scan plan; review the entire file
as usual)`. Do **not** use OCR's diff-mode regex block-strip: `internal/agent/util.go:22`
records a real bug where a hard-coded literal never matched the shipped template and leaked
a raw `{{plan_guidance}}` token into every prompt.

### 6.5 File scout turns

One durable step per turn, up to `DEEP_REVIEW_FILE_MAX_TURNS` (default 3). Transcript
reload uses the **unchanged** `loadMessages(db, childJob)` — it filters on
`eq(aiJobTurns.jobId, job.id)` and nothing else (`src/server/ai/agent-loop.ts:105-112`),
so per-child `jobId` gives us transcript partitioning for free. No sequence banding.

Tools: `read_file`, `read_diff`, `search_code`, `list_files`, `finish_file`, and
`report_finding`.

**`report_finding` must write its rows inside the tool's `execute`.** This is the single
subtlest bug in the design. `persistToolCall` returns the stored output *without
re-executing the handler* on replay (`src/server/ai/agent-loop.ts:141-158`). A findings
buffer populated by the handler and flushed after the turn would be empty on every
replayed step, and the file would silently complete having reported nothing. Write the
rows in `execute`, return the persisted ids as the tool output.

A thrown turn is caught **inside** the step: the item transitions to `failed` with a typed
class and a `sanitizeReason`-scrubbed message, and **every other file continues**. One file's
failure never fails the run. (OCR's review path has the same recover; its scan path
notably does not.)

Also required, because both are per-job today and a fan-out multiplies them by N:
- `AI_MAX_TOOL_CALLS` (default 256) is enforced by `db.$count(aiJobToolCalls, eq(jobId))`
  (`src/server/ai/agent-loop.ts:281-287`). Add a **run-level** pre-turn gate counting
  across the parent tree.
- `AI_MAX_SOURCE_BYTES` (default 8 MiB) is per-job. Add a run-level byte ceiling over
  `ai_job_evidence` for the tree. Tool-call count is the wrong unit for an exposure bound
  — one `read_file` can return a megabyte.

### 6.6 Anchoring — the crux

The model reports `existingCode`, never a line number. Tiers, in order:

| Tier | Search space | Side |
|---|---|---|
| `unit_current` | The owning review unit's hydrated source | current |
| `changed_current` | Only the file's changed line ranges | current |
| `file_current` | The whole current revision | current |
| `file_previous` | The whole previous revision (modified and deleted files) | previous |
| `relocated` | Retry after one LLM re-extraction | either |

Normalization is OCR's, verified at `internal/diff/resolver.go:236-241`: trim → strip one
leading `+` or `-` → trim again; blank lines dropped, so "consecutive" means adjacent
non-blank lines.

**The divergence from OCR: collect every match, then disambiguate.** OCR takes the first
and moves on. We rank candidates by (a) overlap with the file's changed ranges, (b)
containment in a unit the agent has evidence of reading, (c) proximity to the agent's
evidence byte ranges. A tie that survives all three sets `anchorAmbiguous: true` and the
finding routes to the file-level bucket rather than to a wrong line.

**Relocation** is OCR's `RE_LOCATION_TASK` (`internal/diff/relocation.go:20`), kept as its
own narrow call. Copy its swap-and-restore discipline verbatim (`relocation.go:66-77`): if
the re-extracted snippet still fails to anchor, restore the original so the surfaced
evidence is the model's actual claim, not a failed re-extraction.

**Every finding that fails to anchor gets a relocation attempt** — exactly one, and no
run-wide cap. An earlier draft capped it at 20 per run as a cost guard; that is a shortcut
that silently degrades late findings in a large PR into the file-level bucket while early
ones get the full treatment. The natural bound is the finding count, which is already
bounded by the per-file reporting limit.

A finding that never anchors is **never dropped**. It goes to the file-level bucket with
`path` set and `line` absent — which `aiResultSchema` already permits, both fields being
`.optional()` (`src/validators/ai.ts:142-143`).

File-level tiers need a pseudo-unit for `explanationChangedLineRanges`, whose input is
unit-shaped (`src/server/ai/change-scope.ts:8-14`) and which offsets by `unit.startLine`
then clamps to `[startLine, endLine]`. Construct
`{ changeType: file.changeType, startLine: 1, endLine: currentLineCount, source, previousSource }`.

### 6.7 Scope and evidence gates

Two deterministic, free gates that remove the two largest false-positive classes:

- **Scope gate** — an anchor landing entirely on unchanged code becomes `out_of_scope`.
- **Evidence gate** — an anchor outside every byte range the agent provably read becomes
  `ungrounded`. `ai_job_evidence` rows already exist and are unique on
  `(jobId, sourceBlobId, startByte, endByte)`.

The evidence gate must **partition by `sourceBlobId`**, not just compare line ranges: the
table has no side discriminator, so without it a previous-revision anchor can be
"grounded" by a current-revision read.

Both gates **fail closed** — a wrongly positioned comment is worse than a missing one, and
the provider APIs demand a real line and a real side. Both states are retained as rows and
surfaced in the file-level bucket.

**Survey findings are exempt from the hard evidence gate** (they have no per-file byte
ranges by construction) and instead take a one-level severity downgrade when ungrounded.
Without this exemption the one recall class OCR cannot produce is defeated by its own
precision gate.

### 6.8 Refutation

One batched call per file over that file's anchored findings. Input is deliberately
minimized to `[{ id, content, existingCode }]` — no severity, no category, no path, no
confidence — mirroring OCR's input minimization so the judge cannot anchor on the
reviewer's own certainty.

Upgrade over OCR: OCR's `parseFilterResponse` accepts a bare id list, so a lazy "seems
fine" kills a finding for free. Here a refutation must cite `evidencePath` and
`evidenceLine`, **and `evidencePath` is validated against the snapshot's path set**. An
unverifiable citation discards the refutation, and the finding passes.

**Fails open, absolutely.** Provider error, timeout, unparseable response, duplicated id →
every finding stays `unverified` and is surfaced. A refuted finding is persisted with its
refutation text — an auditable discard, not a deletion.

### 6.9 Survey

One whole-PR agent, dispatched after every file agent completes so it can reference what
the file agents found without polluting their prompts. Input: the file manifest, unit
names/kinds/paths, dependency edges, PR title and description. **No file bodies** — it
pulls what it needs through tools.

Distinct tool schema (`reportSurveyFindingSchema`) carrying
`locations: Array<{ path, existingCode }>` with a minimum of 2, since a cross-file finding
that names one file is a file finding.

### 6.10 Dedupe

Deterministic collapse first, on `(path, anchorSide, startLine, endLine, sha256(normalizedTitle))`,
then **always** one LLM cluster call over what survives. No size gate: the deterministic
pass only catches findings that agree on an exact anchor and title, which is the easy half
of the problem — two agents describing the same defect in different words on adjacent lines
is the case that actually matters, and it is precisely the case a threshold would skip.

The response must **partition every input id exactly once** — no unknown id, no duplicate,
no omission — or the entire response is rejected and every original kept (OCR's
all-or-nothing discipline, `internal/scan/agent.go:986-999`).

Add a bound OCR lacks: reject any grouping whose largest group exceeds a cap (4) or whose
members span more than one path unless the deterministic pass already matched them. A
response putting all ids in one group is a *valid partition* and would suppress everything;
see §9.

Only the canonical member's body may change. Anchor, severity, side, `unitId` and evidence
always come from a real finding, so merging can never break a location.

### 6.11 Finalize

1. Sweep items still in `selected` to `failed` by precedence (run-failure class > pending
   budget cause > `unknown`).
2. Assert the coverage partition.
3. Freeze `orderIndex` on every surfaced finding, ordered by (severity rank, path,
   startLine, id) — **before** the projection, because `acceptAiJobResult`'s replay
   tolerance is `isDeepStrictEqual` (`src/server/ai/service.ts:571-574`).
4. **Roll child usage up onto the parent, then settle.**
5. Hand the projection to the unchanged `acceptAiJobResult`.

Step 4 is a blocker, not an optimization. Every model call happens on a child; the parent
makes none. `settleAiJobQuota` reads usage from a single job row, and — verified at
`src/server/ai/service.ts:481` — returns early *before* the `ai_usage` write when both
reserved token fields are zero:

```ts
if (!job.reservedInputTokens && !job.reservedOutputTokens) return;
```

Children hold zero reservations by design, so without a rollup a 2.5M-token deep review
records ~0 monthly tokens and ~0 USD. `MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT` and the
workspace budget both become unenforced. The fix needs no change to `settleAiJobQuota`,
because `nonReducingAiUsage` takes the max of the persisted row and the reported usage
(`src/server/ai/usage.ts:19-33`):

```sql
select sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
       sum(cache_write_tokens), sum(total_tokens), sum(actual_micro_usd)
  from ai_job where id = $parent or parent_job_id = $parent
```

then `settleAiJobQuota(db, parentJobId, treeUsage)`.

Terminal state derives from **coverage alone, never from finding count**: `complete` when
nothing failed, `skipped` when nothing was selected, `failed` only when every selected item
failed, otherwise `partial`. A budget stop is a pending failure cause, not a run failure —
a truncated run reports `partial` and the job still completes successfully.

Persist it: `ai_job.deepReviewTerminalState` and `ai_job.runFailureClass`, both exposed on
`ai.reviewStatus`. The algebra is worthless if it has nowhere to live.

### 6.12 Cancellation

`ai.cancel` today resolves one job by id, cancels its `workflowRunId`, marks that row
cancelled and settles its quota. Children have no `workflowRunId` of their own, so
cancelling the parent kills the workflow mid-run: `finalizeDeepReview` never runs, every
item stays `selected`, and the tree is permanently non-terminal.

Required:
- `ai.cancel` rejects a child job id (`isNull(aiJobs.parentJobId)`).
- On a deep-review parent it runs a terminal sweep in the same transaction — every
  non-terminal child cancelled, every `selected` item `failed(cancelled)` — then
  `finalizeDeepReview` so the partition closes.
- `executeReviewFileTurn` re-reads the parent's `cancelledAt` before each turn.
- `pruneStaleAiReservations` must exclude parents with live descendants, or it will settle
  a parent while its tree is still spending.

---

## 7. What the UI needs

`review.deepReviewFindings` (new query) returns findings joined through
`parentJobId → ai_job`, plus the coverage payload.

Required changes, none optional:

- **Widen the poll predicate.** `refetchInterval` fires only for `["queued", "running"]`
  (`src/components/review/review-workspace.tsx:1695-1698`) while the status enum also has
  `waiting_for_provider` and `streaming`. A run parked in either looks frozen — and a
  deep-review parent sits in `waiting_for_provider` from `startAiJob` until seal-plan.
- **Split `ai.usage`.** It computes `count(aiJobs.id)` and the token sums over one rowset.
  Adding `isNull(parentJobId)` fixes the run count and destroys the token count, because
  children carry all consumption. Use
  `count(*) filter (where parent_job_id is null)` for runs and leave the sums over the
  whole tree.
- **Publish path.** `review_comment.unitId` and `review_comment.line` are both `notNull`
  (`drizzle/schema.ts:1202-1212`), so `unanchored`, `out_of_scope` and `ungrounded`
  findings are structurally unpublishable — surface them read-only.
  `publishReviewCommentSchema`'s `superRefine` (`src/validators/review.ts:119-152`)
  rejects an `aiJobId` without exactly one of `aiFindingIndex`/`aiCommentIndex`, so it
  needs a third AI shape keyed on `aiFindingId`. **Keep the existing job-scoped
  authorization predicate** (`userId`, `pullRequestId`, `snapshotId`, `status`) and add
  the row predicates *on top* — authorization today lives in the job lookup, not in the
  finding.
- **Terminal-state and failure UI.** There is no failed-review panel today; the error
  panel keys on the explain job.
- **Category and severity filtering.** Findings carry OCR's 8 categories and 4 severities
  (§3.1). A large review is triaged by category first, so the findings list needs both as
  filter dimensions, and the existing three-colour severity rendering needs a fourth.
- **Gate both review entry points on `deepReviewAvailable`** (§6.1): the Review button and
  the auto-start `useEffect` at `review-workspace.tsx:2418-2440`. The effect is the one
  that bites — it fires on page load, so an ungated free account gets a failed mutation
  every time it opens a pull request.
- **Do not advertise what the account cannot run.** When `deepReviewAvailable` is false,
  the review affordance is absent rather than present-and-erroring, and the AI settings
  `reviewPullRequests` toggle is disabled with a plan explanation
  (`src/components/settings/ai-settings.saas.tsx`). The toggle currently defaults from
  `workspace.aiReviewEnabled` and is independent of entitlement.

---

## 8. Rulebooks: vendoring and attribution

**Inventory, measured:** 35 files, 1,336 lines, 120,428 bytes in
`internal/config/rules/rule_docs/`. Substantial: `go.md` (10.8 KB), `php.md` (8.3 KB),
`haskell.md` (7.5 KB), `python.md` (7.4 KB), `prisma.md` (6.4 KB), `rust.md` (6.2 KB),
`kotlin.md` (4.9 KB, 134 lines). Near-empty stubs: `yaml.md` (86 B), `json.md` (93 B),
`build_gradle.md` (199 B), `pom_xml.md` (286 B). The glob→file map
`system_rules.json` is 1.2 KB.

### 8.1 Layout

```
src/server/review/deep/rulebooks/
├── LICENSE            # verbatim Apache-2.0 text
├── NOTICE             # attribution + list of modifications
├── index.ts           # generated: glob → imported markdown string
├── system-rules.json  # vendored, unmodified
└── docs/*.md          # 35 vendored rulebooks
```

`rulebooks.ts` resolves a path to **two** rulebooks — language (by extension) and
framework/pattern (by path glob, e.g. `.github/workflows/**`) — concatenated. This is
strictly more than OCR does with one lookup, and it carries a second lens dimension into
the agent's checklist at zero extra model calls.

### 8.2 Attribution — required, and not automatic

**None of the 35 `.md` files carries an SPDX or copyright header.** Only OCR's `.go`
sources do. Verified: `grep -l -i "SPDX\|Copyright" rule_docs/*.md` returns zero files. So
attribution must be added by us at the directory level; copying the files verbatim carries
no notice with them.

There is **no `NOTICE` file** in OCR's repo at the pinned revision, so Apache-2.0 §4(d)
adds nothing — but re-check at whatever revision you actually vendor.

Obligations under Apache-2.0 §4, all satisfied by the layout above:
- §4(a) include a copy of the License → `rulebooks/LICENSE`
- §4(b) mark modified files as changed → `NOTICE` lists every modification
- §4(c) retain notices from the source → none exist in these files; state that in `NOTICE`

Draft `NOTICE`:

```
The Markdown rulebooks in ./docs and system-rules.json in this directory are
derived from the Open Code Review project:

    https://github.com/alibaba/open-code-review
    Copyright 2026 alibaba/open-code-review Contributors
    Licensed under the Apache License, Version 2.0 (see ./LICENSE)

Vendored from commit <PIN THE SHA> on <DATE>.

Modifications by ReviewDuck:
  - <list files changed and how; "none" if verbatim>

The upstream .md files carry no per-file copyright or SPDX headers; this NOTICE
is the attribution for all of them.

ReviewDuck as a whole is licensed under AGPL-3.0-only. Apache-2.0 is one-way
compatible with AGPL-3.0, so this material may be incorporated here; the
combined work is distributed under AGPL-3.0-only.
```

Add a line to `THIRD_PARTY_NOTICES.md` and ensure the release SBOM picks up the directory.
Do **not** use OCR's name or logo as branding; Apache-2.0 §6 grants no trademark rights.
Factual attribution only.

### 8.3 Scope — all 35, no pruning

**Every rulebook is vendored, verbatim, and stays.** Pruning the corpus to the languages
we expect would narrow the reviewer's capability for no benefit: a rulebook costs nothing
until a file matches its glob, and a workspace with Kotlin or Terraform or Haskell in it
gets a materially better review because `kotlin.md`, `terraform.md` and `haskell.md` are
present. The prompt-token cost of the corpus is **zero** for any file that does not match —
only the one or two resolved rulebooks are ever interpolated (§4, `rulebooks.ts`).

The near-empty stubs (`yaml.md` at 86 B, `json.md` at 93 B, `build_gradle.md`, `pom_xml.md`)
are kept as-is rather than dropped. They resolve to a real, if thin, checklist, and
dropping them would send those paths to `default.md` — strictly less specific. Writing
better content for them is a legitimate later improvement; deleting them is not.

`ruleConfigDigest` = `sha256` over the resolved corpus, stored on the parent job and part
of the reuse fingerprint (§6.3), so any future edit to a rulebook correctly invalidates
findings cached against the old text.

### 8.4 The deferred repo-committed rules layer

`resolveRulebooks` returning `{ language, framework, patterns }` makes a future
`.reviewduck/rules.json` layer cheap. **State the trust boundary now, in the same document
that designs the extension point**: a repo-committed rules file is written by the PR author
— the exact adversary — and lands in the instruction slot of the reviewer's own checklist.
It must be wrapped as untrusted data, must never be labelled "Mandatory" (OCR's
`merge_system_rule` scaffolding uses the heading `## User-Specific Rules (Mandatory)`), and
must not be able to narrow the mandate or suppress a finding class. Prefer restricting the
repo layer to non-instruction content entirely.

---

## 9. Security

**Threat model — the PR author.** They control file contents, file paths, symbol names, PR
title and description, commit messages, and (under the deferred layer) the reviewer's
checklist. Their goal is to suppress a finding about their own code.

The fan-out creates **two new suppression channels** that the single-agent reviewer does
not have, and both invert the usual "fail open is safe" reasoning:

- **The refuter** is the one gate where a successful injection *deletes a real finding*.
  Its user message contains the attacker's full file. Mitigations: keep the
  never-follow-instructions preamble in the refuter's system prompt (not just the scout's);
  wrap the findings payload in an untrusted-data element; validate `evidencePath` against
  the snapshot path set.
- **The dedupe call** can collapse N findings into 1, and the partition check does not
  catch it — one group containing every id is a valid partition. Hence the largest-group
  cap in §6.10.

Additional requirements:

- **Every one of the five new model calls** (plan, relocate, refute, dedupe, survey) must
  resolve through `resolveAiModel` and spread `resolved.providerOptions`. Those options are
  where `zdr: true`, `data_collection: "deny"`, `allow_fallbacks: false` live
  (`src/server/ai/models.ts:17-29`), and on local deployments `createSafeRemoteFetch` is the
  only thing preventing a workspace-configured base URL from reaching a private host.
- **Escape every interpolated value** through `escapePromptXml` (`src/config/prompts.ts:29-37`)
  — paths, symbol names, manifest entries, not just the PR title. `untrustedFileSource`
  (`src/server/ai/agent-loop.ts:50-59`) escapes both the body and the path attribute; match
  it. Test cases: a path containing `</untrusted-file>`, a symbol name containing angle
  brackets.
- **`sanitizeReason` must be wired into `failAiJob`**, not only into item reasons.
  `failAiJob` writes `cause.message` straight to `ai_job.error`
  (`src/server/ai/agent-loop.ts:826-841`) and `ai.reviewStatus` returns that row to the
  client. A provider error containing `https://user:pass@host` or a bearer token is
  currently persisted verbatim. Fixing this is behaviour-preserving for existing callers
  and is worth doing regardless of the rest of this plan (§11).

---

## 10. Limits: what breaks first

Verified numbers, in the order they bite:

| # | Limit | Value | Where |
|---|---|---|---|
| 1 | Postgres pool | `max: 5` production, `2` dev | `src/server/db/index.ts:20` |
| 2 | Wall clock | `AI_MAX_DURATION_MS` default 1,800,000 (30 min) | `src/env.js:92` |
| 3 | Vercel function | `maxDuration: 800s`, `memory: 2048` for `api/ai/**` | `vercel.json` |
| 4 | Paid monthly tokens | 5,000,000 | `src/env.js:73` |
| 5 | Free monthly tokens | 100,000 — cannot fund a fan-out | `src/env.js:68` |
| 6 | Per-job tool calls | 256 | `src/env.js:79` |
| 7 | Per-job source bytes | 8 MiB | `src/env.js:86` |
| 8 | Provider REST | GitHub 5,000 req/hr per installation | — |

### 10.1 Coverage is uncapped; execution slots are not

**Every reviewable file is reviewed. There is no file cap and no `file_cap` waiver.** That
is a decision about *coverage*, and it is separable from how many agents run at the same
instant.

A 400-file review therefore does not mean 400 simultaneous children. It means 400 children
that all complete, drawn from a bounded pool of execution slots as capacity frees. This is
**not** the wave design that was rejected: waves imposed a barrier — dispatch W, wait for
all W, dispatch the next W — so one slow file stalled its whole batch. A slot pool has no
barrier. Every child is dispatched immediately, runs as soon as a slot opens, and releases
it on completion. Throughput is identical to unbounded dispatch on any run that fits, and
correctness is identical on runs that do not.

**Raise the pool too — do not size the reviewer to the old one.** `max: 5`
(`src/server/db/index.ts:20`) was sized for an app whose heaviest AI operation was a single
agent:

```ts
max: env.NODE_ENV === "production" ? env.DATABASE_POOL_MAX : 2,
```

with `DATABASE_POOL_MAX` a new validated env var, sized as
`executionSlots × perChildConnections + polling + cron + headroom`.

Two facts bound the slot count, and the prerequisite measurement (§11) settles it:
Postgres has a `max_connections` ceiling shared across every application instance, and on
Vercel each concurrent function instance carries its own pool.

### 10.2 The real ceiling on a huge PR is tokens, not connections

Connections are a scheduling problem with a scheduling answer. The token reservation is
not: a 400-file review at the modelled per-file cost exceeds
`MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT` (5,000,000) outright, and
`managedInvestigationReservation` clamps any single reservation to 80% of the monthly
limit (`src/server/ai/turn-guards.ts:34`).

Handle it honestly, **before** spending anything. `createAiJob` already loads the snapshot
via `jobScope`, so the reviewable file count is knowable at creation time — reserve for the
real N rather than a nominal one. A run that cannot be funded then fails at `ai.start`
with the existing allowlisted `"Monthly AI token limit reached"`, having spent nothing,
instead of dying half-reviewed at file 180 and reporting `partial`.

That is the one place a very large PR is refused, and it is refused for a true reason
(the user cannot afford it) rather than an arbitrary one (an implementation cap).

Note also that `executeReviewFileTurn` inherits the `FourWaySemaphore`
(`src/server/ai/agent-loop.ts:61-78`), whose capacity 4 is hard-coded. Parameterize it for
the child path.

**Provider API amplification is unbudgeted and worse than it looks.**
`createAiRepositoryContext` memoizes `listFiles()` *per instance*, and `executeAiTurn`
builds a new context every turn (`src/server/ai/agent-loop.ts:328`). At 24 files × 3 turns
that is ~72 `git/trees?recursive=1` calls per review. `context.ts` must build **one context
for the whole run**, cached on the parent.

---

## 11. Build order

**This is a dependency graph, not a release plan.** There is one deliverable and it is
complete or it is not: no reduced first version, no feature flag holding a stage back, no
stage disabled at runtime, no staged rollout. The order below exists only because
`validate.ts` imports `anchor.ts` and you cannot write the importer first. Everything
lands before deep review is reachable from the UI.

**Prerequisites** — two independent fixes and two measurements. Not a phase; these simply
have no dependency on the rest and one of them gates a config value.

*Fixes, each correct on its own merits:*
- Wire `sanitizeReason` into `failAiJob` and `workflowRuns.error` (§9). Today a provider
  error containing a bearer token is persisted verbatim and returned to the client.
- Populate `snapshot_file.previousPath` in every provider (§5), so renames carry a real
  old path.

*Measurements, because `DATABASE_POOL_MAX` cannot be picked by argument:*
- Do parallel workflow steps share a process and a connection pool? This sets the pool
  size and the execution-slot count (§10.1).
- `read_file` latency and provider rate-limit headroom at full fan-out width.

**1 — pure modules, no wiring.** `selection.ts`, `rulebooks.ts`, `anchor.ts`,
`coverage.ts`, `findings.ts`, `redaction.ts`, `refute-policy.ts` + tests. Vendor the
rulebooks with `LICENSE`/`NOTICE`. Nothing is reachable from the app yet; the whole phase
is unit-testable. *Verification:* `pnpm check` passes; anchor tests cover every tier plus
the ambiguity ladder.

**2 — schema.** Edit `drizzle/schema.ts` to its final shape, delete the existing
`drizzle/*.sql` and journal, regenerate a single baseline with `pnpm db:generate`
(§3). *Verification:* a fresh database provisions from the baseline alone and
`pnpm test:integration` passes against it.

**3 — the workflow spine.** `plan.ts`, `pull-request-review.ts`, the `startAiJob`
kind branch, `createReviewChildJob`, `finalize.ts` with the usage rollup, `cancel.ts`, and
the raised `DATABASE_POOL_MAX`. Children are dispatched and complete with zero findings —
the fan-out is real, only the model call is absent. *Verification:* an integration test
asserting coverage partitions at full width, terminal state is `complete`, and `ai_usage`
reflects the whole tree.

**4 — the file agent.** `file-agent.ts`, `file-tools.ts`, `context.ts`,
`review-prompts.ts`, `validate.ts` (anchor + relocate + gates). *Verification:* a fixture PR
end to end; assert `report_finding` rows survive a replayed step.

**5 — quality stages.** `plan` pre-pass, `refute`, `survey`, `dedupe`.
*Verification:* precision/recall against a labelled fixture set; assert fail-open on refuter
error and all-or-nothing on dedupe.

**6 — read paths, gating, and deleting the old reviewer.**
`review.deepReviewFindings`, `ai.usage` split, poll predicate, publish path +
`src/validators/review.ts`, terminal-state UI. Plus the entitlement work from §6.1:
`deepReviewAvailable` on `ai.configuration`, both client entry points gated, the
`safeAiStartMessages` entry, and the settings toggle disabled for unentitled accounts.
**The single-agent reviewer is deleted here** (§6.1b), in the same change — no drain, no
dual path. *Verification:* the `review` branch of `reviewDuckAgentPrompt` is gone and
`pnpm check` passes with `jobKind` narrowed to `"explain"`; an unentitled SaaS account sees
no review affordance and fires no mutation on page load; an entitled account and a local
appliance both run a full deep review.

---

## 12. Test plan (the cases that are easy to forget)

- A replayed `report_finding` tool call does not duplicate rows and does not lose them.
- A parent whose `startedAt` exceeds `AI_MAX_DURATION_MS` stops dispatching and finalizes
  `partial`.
- A 3-child run reports `runs: 1` with the tree's full token total, and `ai_usage` for
  `(workspaceId, userId, day)` reflects it.
- Cancel mid-run closes the partition and leaves no non-terminal child.
- Two concurrent deep reviews of one snapshot by different users.
- A snapshot pruned mid-run (`pruneExpiredReviewSnapshots` cascades to the parent).
- An unentitled SaaS account: the auto-start effect fires no mutation on page load, and a
  direct `ai.start({ kind: "review" })` is refused with the allowlisted message rather than
  the generic fallback.
- A local appliance with no Clerk at all still gets `deepReviewAvailable: true`.
- The same user triggering two deep reviews of one snapshot: the existing dedupe advisory
  lock on `${snapshot.id}:${userId}:review:...` must collapse them to one run. (Two
  *different* users cannot reach one snapshot today — see §6.3 — but the lock is keyed on
  userId, so this becomes a real case the moment workspace sharing ships.)
- A previous-side anchor is not grounded by a current-side evidence row.
- A refuter response citing an unknown `evidencePath` does not kill the finding.
- A dedupe response placing every id in one group is rejected.
- A path containing `</untrusted-file>` is escaped.
- A finding on a file excluded by `bigPickleSourceDecision` is never produced.

---

## 13. Open decisions for the owner

1. ~~Free tier: refuse or fall through?~~ **Resolved: refuse, and scrap the old reviewer.**
   Deep review replaces the single-agent reviewer rather than supplementing it, so
   unentitled SaaS accounts get no PR review at all — the affordance is hidden, not shown
   and erroring (§6.1, §6.1b). Confirm the product consequence: **PR review leaves the
   free tier entirely**; explain and question threads stay.
2. ~~Does "paid only" also disable deep review on the local appliance?~~ **Resolved: no.**
   The gate is `subscribed || isLocalDeployment()` — paid-only on the hosted plan,
   available to every appliance operator, who pays their own provider bills (§6.1a).
3. ~~Does reuse cross users within a workspace?~~ **Moot.** A workspace has exactly one
   member today (§6.3); there is no sharing mechanism to reason about.
4. ~~Rulebook curation.~~ **Resolved: keep all 35, verbatim, including the stubs.** A
   rulebook costs nothing until a file matches its glob, so pruning only narrows
   capability (§8.3).
5. ~~Deleted files.~~ **Resolved: reviewed.** Previous-revision prompt, `anchorSide:
   "previous"`, `side: "left"` on publish, and full participation in the survey pass
   (§5). `deleted` is not a valid exclusion reason.
6. ~~Default wave width.~~ **Resolved: there are no waves.** Every child is dispatched
   immediately with no barriers; the DB pool is sized to the fan-out rather than the
   fan-out throttled to the pool. Instantaneous concurrency is bounded by execution slots,
   which is a scheduling detail, not a coverage limit (§10.1).
7. ~~Language.~~ **Resolved: English only, no setting.** OCR appends
   `"Always respond in <lang>."` to every system message
   (`internal/config/template/template.go:184`), defaulting to English when unset.
   ReviewDuck has no language setting anywhere, so we simply do not port the directive —
   no column, no settings UI, and nothing to thread through the five model calls. Revisit
   on demand; the prompts are one interpolation away from supporting it.
8. ~~Severity and category taxonomy.~~ **Resolved: adopt OCR's fully** — 4 severities and
   8 categories, mirroring `internal/tool/code_comment.go:16-46`, including its
   degrade-don't-reject normalization (§3.1).
9. ~~Max files per review.~~ **Resolved: no cap, review everything.** Coverage is uncapped
   and `file_cap` is not a valid exclusion reason. Bounded execution slots (not waves)
   drain an arbitrarily large run without dropping a file, and the only true refusal is an
   unaffordable token reservation, detected at `ai.start` before anything is spent
   (§10.1, §10.2).

**Nothing is open.** The one number still to establish, `DATABASE_POOL_MAX`, is a
measurement rather than a decision (§11).

---

## 14. Licensing summary

ReviewDuck is AGPL-3.0-only (`package.json`). OCR is Apache-2.0. Apache-2.0 is one-way
compatible with AGPL-3.0: we may incorporate their material, the combined work stays AGPL,
and the reverse would not be permitted — so the flow must stay one-directional.

Because this plan **ports mechanisms and vendors data rather than linking a binary**, the
obligations are §4(a)–(c) as handled in §8.2. Contributing anything back upstream would
require signing Alibaba's CLA; that is a reason to prefer our own implementation over a
fork we would need to maintain patches against.

---

## 15. What the first live run changed

Validated against `studie-tech/TheNinjaRPG#1370` — 55 changed files, 423 review
units, 21,348 additions. Five defects only a real run could surface.

**The agent never concluded.** Every file used all three turns investigating and
reported nothing: 6.7M tokens, zero findings, `report_finding` never called once
across 27 completed files. Investigation is open-ended and the model always finds
one more thing worth reading, so a turn budget alone does not produce a
conclusion. The final turn now carries only the tools that can *end* a review
plus an instruction saying the budget is spent — the tool restriction is what
makes the instruction binding rather than advisory.

**The tool ceiling was sized for one agent.** `AI_MAX_TOOL_CALLS` is per job.
Shared across a fan-out, the first 27 files spent the whole 256 and the remaining
28 failed `tool_limit` without being reviewed. It now scales with the sealed
denominator via `DEEP_REVIEW_TOOL_CALLS_PER_FILE`, because what the ceiling
bounds is repository exposure, and that grows with the files under review.

**Every category collapsed into `other`.** The tool takes a free string so an
unknown category degrades a finding rather than failing the call — but the model
reports `correctness`, `validation` and `vulnerability`, none of which are
category names. All 10 early findings landed in `other` and the category filter
had nothing to filter. Near-misses now map to the category they plainly mean.

**A TLS blip lost a file permanently.** One `ssl3_read_bytes ... bad record mac`
threw a turn, and the durable step turned that into a permanent failure. The
child recorded `provider_failure` while the item recorded `unknown`. Transport
failures now classify as `provider` and a turn retries them with a widening
pause; budget, cancellation and timeout are decisions, not blips, and still fail
on the first answer.

**Two UI defects.** Coverage counted "units" when it meant files — a unit is a
symbol, and this pull request has 423 of them across 56 files. And the coverage
list sat in an implicit grid track, which takes the width of its widest item, so
one deep source path pushed every row past the panel edge.

### What held up unchanged

- **Coverage algebra.** The truncated first run reported `partial` with
  `deep_review_partial`, and 27 completed + 28 failed + 1 waived partitioned the
  56 sealed items exactly.
- **Anchoring.** Every finding resolved at `unit_current` with a real line range
  and zero ambiguous anchors — the model quotes code inside the unit it is
  reviewing, so the first tier catches it. The `changed_current`, `file_current`,
  `file_previous` and `relocated` fallbacks were never exercised in the wild.
- **The evidence gate.** Three findings the agent could not prove it had read
  were held at `ungrounded`, surfaced read-only rather than dropped.
- **Fail-closed publishing.** 32 findings were publishable by design and the UI
  rendered exactly 32 publish actions; the 3 ungrounded ones carried none.
- **Usage rollup.** Children hold no reservation, and the parent settled with the
  whole tree's tokens rather than its own zero.
- **Isolation.** One file's provider failure never failed the run.

### A robustness gap the run exposed

`finalizeDeepReview` is itself a step of `pullRequestReviewWorkflow`. When the
workflow's step jobs exhaust their retries — three consecutive 500s from the
step endpoint did it here — the tree is left permanently non-terminal: children
stay `queued`, items stay `selected`, and the run that is supposed to close the
partition is the very thing that died. Nothing reaps it.

`pruneStaleAiReservations` is the natural owner, but §6.12 already requires it to
skip parents with live descendants, and by that predicate these descendants look
alive forever. It needs a second condition: a parent whose workflow run is dead
and whose children have made no progress past `AI_MAX_DURATION_MS` should be
swept to `failed` and settled, exactly as the cancel path does.

### Still open

- **Cost is not captured.** `actualMicroUsd` settles at 0 because OpenRouter
  returns cost only when the request asks for it; the token counts are right.
- **Input cost is high.** ~180k input tokens per file at three turns, against
  ~20k output. The transcript is re-sent whole each turn, so the plan pre-pass
  and rulebook are paid for repeatedly.
