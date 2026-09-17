# devbox-search migration runbook

Operational checklist for moving `devbox-search` off Jetify's axiom infra onto
Neon + Vercel + GitHub Actions. Tick items off as you go.

The code landed as five stacked PRs (#3 core → #4 schema → #5 seed → #6 API →
#7 indexer), all merged to `main`. This file tracks the things **outside** the
code: accounts, credentials, decisions, and the order to do them in.

## Decisions already made

- **Domain:** we ship on our own domain, not `search.devbox.sh`. This removes
  the Jetify DNS coordination from the critical path. Consequence: shipped
  devbox CLIs still point at `search.devbox.sh` by default, so adoption is via
  `DEVBOX_SEARCH_HOST` (or a later CLI release). API byte-compatibility still
  matters — people will point current CLIs at the new host — so the shadow-diff
  gate stays exactly as strict.
- **Runners (decided 2026-09-16): the eval runs in a separate public repo,
  `mikeland73/devbox-search-indexer`.** Nothing else was available to a
  personal account:
  - GitHub's larger runners (`ubuntu-latest-4-cores`) need a Team/Enterprise
    org — on a personal private repo the jobs **queue forever** rather than
    failing, so a stuck `queued` job is this, not a capacity blip. Blacksmith
    doesn't support personal accounts either.
  - The private repo's free `ubuntu-latest` (2 vCPU / 7.8 GB) **does not fit
    the eval even with swap** — tested 2026-09-16, `nix-env` thrashed for 36
    min and GitHub killed the VM (see 0.2). It wouldn't have been free anyway
    at the Pro plan's 3,000 included minutes.
  - Vercel Sandbox (16 GB, no swap) was rejected once peak RSS measured
    14.1–14.6 GB — no headroom.
  - Public repos get 4-vCPU/16 GB runners and unlimited minutes. The eval is
    only a `nix-env` invocation, so it lives in a public repo with **no
    ported code**: one workflow (`eval.yml`), a README, MIT. It archives each
    (commit, system) eval to R2 at `{system}/{unix-ts}-{hash}.json.gz`.
    `index.yml` here dispatches it via `INDEXER_DISPATCH_TOKEN` (fine-grained
    PAT, Actions read/write on that repo only) and imports from R2.
  - **This repo stays private.** `packages/core` is a faithful port of
    Jetify-internal Go files and this runbook discusses the
    `search.devbox.sh` shutdown; neither belongs on a public repo. History
    was scanned clean on 2026-09-16 regardless, and the Claude workflows in
    both repos are gated to `repository_owner`.

---

## Provisioned resources

Created 2026-08-14. Nothing here is secret; the credentials live in Vercel and
are pulled with `vercel env pull`.

| Thing | Value |
|---|---|
| Vercel team | `mikeland86s-projects` (`team_gCWGCTnBAbx2wqbWisUh4HeL`) |
| Vercel project | `devbox-search` (`prj_q9j4W1L4fsvgcMGSGQpBYOdobKAM`) |
| Git | `mikeland73/devbox-search`, production branch `main` |
| Production URL | https://devbox-search.vercel.app |
| Neon resource | `devbox-search-db` — Neon project `autumn-rain-65994722`, region `iad1` (aws us-east-1), Postgres 17, plan **Launch** |
| Neon org | `org-frosty-butterfly-42439211` (Vercel-managed) |
| Neon branches | `main` only (`br-steep-shadow-auedwzp8`, endpoint `ep-purple-river-auzjl04j`). The `staging` branch was folded into `main` on 2026-09-17 — see [Single branch](#single-branch-since-2026-09-17). |
| Neon dashboard | `vercel integration open neon devbox-search-db` (SSO) |

`neonctl` works against this project — the Vercel-managed org shows up after
`neonctl auth`. Every command needs the org or project id, otherwise it prompts:

```sh
npx neonctl projects list --org-id org-frosty-butterfly-42439211
npx neonctl branches list --project-id autumn-rain-65994722
npx neonctl connection-string main --project-id autumn-rain-65994722 [--pooled]
```

> Neon's default branch here is called `main`, not `production` — same word as
> the git branch, different thing.

Vercel project settings that are **not** in the repo — if the project is ever
recreated, set these again:

| Setting | Value | Why |
|---|---|---|
| Root Directory | `apps/web` | monorepo |
| Install Command | `pnpm install --frozen-lockfile --filter @devbox-search/web...` | skips `packages/indexer`, so the build never compiles `better-sqlite3` |
| Build Command | `pnpm --filter @devbox-search/web... build` | builds `core` → `db` → `web` in topological order; the default `next build` would not build the workspace deps, which resolve to `dist/` |
| Deployment Protection | **off** | previews must be publicly reachable — the shadow-diff harness and a real `devbox` CLI both hit preview URLs and neither can send a bypass header |

### Env vars

Two of the names Neon writes matter, and one needs renaming outside Vercel:

| Neon writes | Endpoint | Used as |
|---|---|---|
| `DATABASE_URL` | pooled | `DATABASE_URL` — what `createServingClient` reads. Used as-is by the app. |
| `DATABASE_URL_UNPOOLED` | direct | `DATABASE_URL_DIRECT` — what `createImportClient` prefers. **Copy the value under the new name** for local seeds and for the GitHub Actions secret. |

The rest (`POSTGRES_*`, `PG*`) are unused by this codebase.

All three Vercel environments (Production, Preview, Development) point at
Neon `main` — the integration-style records `DATABASE_URL` /
`DATABASE_URL_UNPOOLED` are scoped to all three. There is no per-environment
override any more; `vercel env pull --environment=<any>` yields the same
database.

`vercel env pull --environment=production` is the right way to get the
credentials for a local `db migrate` or importer run — don't copy them out of
the Neon console.

### Single branch (since 2026-09-17)

Until 2026-09-17 there were two Neon branches: `main` (empty, prod) and
`staging` (seeded + indexed daily, Preview + the indexer pointed at it). That
was consolidated into one branch holding the full index, and everything —
Vercel Production/Preview/Development, the `DATABASE_URL_DIRECT` GitHub
secret, local tooling — now points at `main`.

How it was done, for the record: a Neon branch *restore* (`neon branches
restore main staging`) copies data instantly but makes the target a
copy-on-write **child** of the source, and Neon refuses to delete a branch
that has children — so restore alone cannot retire `staging`. The actual copy
was `pg_dump --format=custom` of the restored `main` (~3.6 GB logical, a few
minutes) and `pg_restore --jobs=4` into the original root branch, which then
became the default `main`; the old `main` and `staging` were deleted. The
endpoint host changed as part of this (`ep-empty-wind…` → `ep-purple-river…`),
which is why the Vercel records and the GitHub secret were rewritten rather
than left alone.

Neon branching is still the right tool for trying a schema change or a
risky import against real data without touching prod: `neon branches create
--parent main --name <scratch>`, point a local `DATABASE_URL_DIRECT` at it,
and delete it afterwards. Just don't `restore main <scratch>` expecting to
delete `<scratch>` afterwards.

---

## Phase 0 — unblock (do these first)

These are independent of each other and of PR review. Everything else waits on
them. **All four are done** as of 2026-09-16; 0.1/0.2 are kept for the record
of what was measured and why the eval ended up in a second repo.

### 0.1 Pick a runner — **done: public `devbox-search-indexer` repo**

Blacksmith is out (no personal-account support, confirmed 2026-09-16), as are
GitHub larger runners, and 0.2 ruled out the private runner. See the runner
decision at the top for the reasoning.

- [x] ~~Fit on `ubuntu-latest` + swap and stay private~~ — does not fit (0.2)
- [x] ~~Make this repo public~~ — rejected; ported Jetify code stays private
- [x] Eval moved to a standalone workflow in public `mikeland73/devbox-search-indexer`
      (2026-09-16). Secrets set there: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
      `R2_ENDPOINT`, `R2_BUCKET`. Secret set here: `INDEXER_DISPATCH_TOKEN`.
- [x] `index.yml` rewritten to fetch from R2 and dispatch cross-repo (#7 follow-ups, #13)

The swapfile step (now in the public repo's `eval.yml`) sizes itself from
free space; don't hardcode a path or size again — see "Things learned the
hard way" below.

### 0.2 Prove the eval fits in memory — **done**

The probe workflow (`eval-experiment.yml`) was deleted in PR #32 (#18, merged
2026-09-17) once its numbers were recorded here; on this private repo it could
only ever land on the runner where the eval doesn't fit. A one-off manual eval
today is `eval.yml` in the public repo, dispatched with a single system.

- [x] Run **eval-experiment** on `ubuntu-latest` — run 35136891482,
      `x86_64-linux` at `6b5e5b7a` (2026-09-16); earlier attempts died on the
      swapfile step, see below
- [x] Result: **does not fit.** Runner had 7.8 GB RAM, 2 vCPU, 14 GB free
      disk → 8.4 GB swap total. `nix-env` ran 36 min, then GitHub killed the
      VM (`exit 143`, "runner has received a shutdown signal") — the
      swap-thrash signature, not the 180-min timeout. Peak RSS unrecorded
      but >7.8 GB and not sustainable on 8 GB of swap.
- [x] Decided 0.1: public-repo runner (16 GB + swap). Vercel Sandbox's 16 GB
      with no swap would have been within a few hundred MB of peak RSS.
- [x] **Measured on the public 4-vCPU/16 GB runner** (devbox-search-indexer
      run 35143837821, `6b5e5b7a`): wall **2:19 / 3:12 / 3:49** for
      aarch64-darwin / aarch64-linux / x86_64-linux; **~4.5 min per job**
      including the Nix install; **peak RSS 14.1–14.6 GB on a 15 GB runner**.
      The adaptive swapfile is load-bearing, and `eval.yml` fails the run if
      headroom drops under 500 MB (devbox-search-indexer #2) so growth in
      nixpkgs shows up as a red run rather than a slow one.

If the eval ever stops fitting, the ordered fallbacks are:
`nix-eval-jobs --workers 2 --max-memory-size 6000` (needs an output adapter),
then a self-hosted runner (Hetzner ~€6/mo).

### 0.3 Create the Neon project — **done**

Provisioned through the Vercel marketplace integration, so it bills through
Vercel and there's no second account to manage:

```sh
vercel integration add neon --plan launch_v3 -m region=iad1 -m auth=false \
  -n devbox-search-db -e production -e preview -e development
```

Launch, not Free — the free tier's 0.5 GB doesn't fit ~4 GB. `auth=false`
because we don't want Neon Auth. `iad1` matches Vercel's default function
region.

- [x] Neon project created and connected to the Vercel project
- [x] ~~**staging branch** created off `main`~~ — created 2026-08-14,
      **retired 2026-09-17** (see [Single branch](#single-branch-since-2026-09-17)).
      Branch operations go through `neonctl`, not the Vercel CLI:

```sh
npx neonctl branches create --project-id autumn-rain-65994722 \
  --name staging --parent main
```

  A Neon branch is copy-on-write, so `staging` came up already holding the
  migrated schema — no second `migrate` run needed.

- [x] ~~**Preview** repointed at staging~~ — reverted 2026-09-17; all three
      environments share `main` again, on purpose this time

> The unpooled string is not optional for seed and import. COPY and
> session-level advisory locks do not work through Neon's pooler
> (transaction-mode pgbouncer).

### 0.4 Create the Vercel project — **done**

Project, root directory, and build commands are all set (see
[Provisioned resources](#provisioned-resources)), and a manual `vercel deploy`
from the repo root builds green.

- [x] Project created, Neon connected, deployment protection off
- [x] Vercel GitHub App granted access to the repo. The repo is private and the
      app is installed with *selected repositories*, so this had to be done at
      https://github.com/settings/installations → **Vercel** → Configure →
      Repository access. Worth remembering for the next private repo.
- [x] Repo connected, production branch `main`. Pushes to `main` deploy to
      Production; every other branch gets a Preview deployment.

---

## Phase 1 — core + schema

- [x] Review and merge **PR #3** (core domain logic — pure logic, no services)
- [x] Review and merge **PR #4** (schema — pure DDL)
- [x] Apply migrations to Neon `main`. `staging` was branched afterwards and
      inherited all 8 tables, so it needed no separate run.

For any **future** migration there is a single branch to run it against.
**This is automated** (#37): `migrate.yml` runs on every merge to `main` that
touches `packages/db/drizzle/` and migrates Neon `main` via the
`DATABASE_URL_DIRECT_PROD` secret (its `staging` matrix leg skips with a
notice now that `DATABASE_URL_DIRECT_STAGING` is deleted). To run it by hand
— before an import, or to confirm the branch is current — dispatch it from
the Actions tab with `target=prod`; an up-to-date branch prints `up to date`.
It shares `index.yml`'s concurrency group so DDL never runs mid-import. If
you ever add a scratch branch, remember branching is a point-in-time copy,
not ongoing replication — each branch needs its own `migrate`.

Locally, the same thing is:

```sh
pnpm install
pnpm --filter "@devbox-search/db..." build
DATABASE_URL_DIRECT=<direct-url> pnpm --filter @devbox-search/db migrate
```

The build step is not optional: `migrate` runs `dist/migrate.js`, and the
`core` → `db` dist chain has to exist first.

All five PRs are merged, so there's nothing left to retarget.

---

## Phase 2 — seed and validate

- [x] Review **PR #5** (seed)
- [x] ~~Temporarily bump staging compute~~ — not needed: the staging seed ran in ~10 min on default compute (2026-09-16)
- [x] Run the seed **locally**, not in CI (staging, 2026-09-16; needed migration 0001 first — `semver_*` widened to bigint):

```sh
pnpm --filter "@devbox-search/indexer..." build
DATABASE_URL_DIRECT=<staging-direct> \
  node --max-old-space-size=8192 packages/indexer/dist/seed.js \
  ~/devbox-search-data/nixpkgs-compact-2026-08-13.db
```

- [x] Check `seed-report.txt`. Row counts are hard assertions and must match
      exactly:

  | table | expected |
  |---|---|
  | variants | 3,800,488 |
  | versions | 1,445,177 |
  | packages | 248,524 |
  | commits | 2,751 |

- [x] Spot-check the ordering divergences. These are **expected** (sanctioned
      change #4 replaced a non-transitive comparator) and already enumerated in
      `~/devbox-search-data/ordering-report.txt`: 764,913 pairs across 10,004
      packages, and **0** prerelease divergences. You're sanity-checking that
      the new order is right where it differs, not reading 765k lines.
- [x] ~~Drop staging compute back down~~ — n/a, never bumped
- [x] Merge PR #5

---

## Phase 3 — API and the shadow gate

**This is the riskiest phase.** It's the first time the ported query semantics
meet real recorded responses. Budget for a round or two of fixes.

- [x] Create the Vercel project: root directory `apps/web`
- [x] Set `DATABASE_URL` (pooled, staging) for the **Preview** environment
- [x] Deploy a preview. PR #6 is merged, so any non-`main` push produces one;
      `vercel deploy` (no `--prod`) from the repo root does the same on demand.
      Already verified end to end against the staging branch: `/readyz` → `ok`,
      `/v1/search?q=python` → `{"num_results":0}`.
- [ ] Run the shadow diff:

```sh
node tools/shadow-diff.mjs https://<preview-url> --json shadow-report.json
```

  **The gate:** every `/v1/resolve` and `/v2/resolve` divergence must classify
  into a sanctioned class. Unclassified divergences fail and exit non-zero.
  Search and `/pkg` ranking drift is reported but does not gate.

- [ ] Run a real CLI against it:

```sh
DEVBOX_SEARCH_HOST=https://<preview-url> devbox add python@3.11 hello go@1.22
```

- [x] Merge PR #6
- [x] ~~Bump prod compute, seed the prod branch~~ — moot: the fully indexed
      staging data *became* `main` on 2026-09-17, migrations 0000–0003 applied
- [ ] Promote to Production. `DATABASE_URL` for the Production environment
      already points at Neon `main`, and git is connected, so a push to `main`
      does it. `vercel deploy --prod` forces one without a commit.

At this point the service is live on a frozen dataset. The indexer is not
required for it to be useful.

> **Current state:** https://devbox-search.vercel.app is already deployed and
> serving against the *empty* production branch — schema applied, zero rows.
> `/readyz` returns `ok`; `/v1/search?q=python` returns `{"num_results":0}`.
> That's the expected shape until the seed runs.

---

## Phase 4 — indexer

- [x] Create the Cloudflare R2 bucket (free tier ≈ 3–5 years of eval archives) — `devbox-search-evals`, location hint `enam`
- [x] Add repo secrets:

  | secret | used by |
  |---|---|
  | `DATABASE_URL_DIRECT` | discover, import, status |
  | `R2_ACCESS_KEY_ID` | eval archive upload |
  | `R2_SECRET_ACCESS_KEY` | eval archive upload |
  | `R2_ENDPOINT` | eval archive upload |
  | `R2_BUCKET` | eval archive upload |

  `DATABASE_URL_DIRECT` is the value Neon publishes as `DATABASE_URL_UNPOOLED`
  — it pointed at staging until 2026-09-17 and at `main` since. Pull it with
  `vercel env pull` rather than copying it from the console.

- [x] ~~Apply the `runs-on` decision from 0.1~~ — moot: the eval left this
      repo. `index.yml` runs entirely on standard runners.
- [x] Merge PR #7
- [x] Point the workflow at **staging** — `DATABASE_URL_DIRECT` is the
      staging direct URL (set 2026-09-16). `discover` works end to end:
      run 35133999914 picked `6b5e5b7a` (2026-08-13), the first release after
      the seed head, exactly as designed.
- [x] **The daily loop is live on staging** (2026-09-16). seq 2752
      (`6b5e5b7a`) imported on all three systems from public-repo archives.
- [x] **Backlog cleared** (2026-09-17, #20): the seed ended 2026-08-12 and
      ~40 releases had accumulated. Seven manual runs at `limit=10–15` took
      staging from seq 2752 to **2795 = `c7def046`** (nixpkgs-26.11pre1073483),
      the nixpkgs-unstable head at the time. Every eval succeeded; run 2
      surfaced #30 (`stage_versions` still int4). The cron's `limit=4` is
      plenty from here.
- [ ] Soak for ~1 week (started 2026-09-17)

  Daily sanity checks:
  - new commits appear and `commit_systems` fills in for all **3** systems
    (x86_64-linux, aarch64-linux, aarch64-darwin — see "x86_64-darwin" below)
  - `commit_systems.nix_version` stays at the pinned Nix (2.35.2; the eval
    workflow pins `nix-package-url`). A change here without a deliberate
    bump in `devbox-search-indexer` is the first suspect for odd counts (#19)
  - ranges open and close in plausible numbers
  - changed variants per commit is **~1,500–1,800 per system**. ~75k per
    commit means stubs got through (#19/#21); millions would mean content
    hashes disagree with the seed, i.e. the importer and seed are hashing
    differently

- [x] Switch to **prod** — 2026-09-17, `DATABASE_URL_DIRECT` now the `main`
      direct URL (there is no other branch)
- [ ] Keep shadow-diffing daily

**How a day's indexing works.** `index.yml` (header comment has the exact
ordering) discovers releases newer than the DB head from the nix-releases
bucket, dispatches `eval.yml` in the public repo for any (commit, system) not
yet in R2, **waits for those archives to land** (#14, PR #34 — polls R2 up to
`wait_minutes`, default 20, stopping early once every dispatched run has
finished), then fetches and imports everything archived for the pending
commits. A commit is searchable minutes after it appears on the channel
instead of the next day. Leaving on the wait cap is a `::warning`, not a
failure: whatever landed is imported and the rest is re-listed tomorrow.
`commit_systems` records which pairs landed; `discover --systems` re-lists a
commit missing one. Public-repo runs are at
https://github.com/mikeland73/devbox-search-indexer/actions/workflows/eval.yml.

**Catching up a backlog** (more than a handful of releases pending):

```sh
gh workflow run index.yml -f limit=15 -f wait_minutes=30
```

- `discover --limit` counts *all* pending commits, archived-but-unimported
  ones included. Cap ~15: the `index` job's `timeout-minutes` is 120 and a
  run costs `wait_minutes` of idling plus ~2 min of import per commit.
- Evals are ~4.5 min per job and the public repo runs 20 jobs concurrently,
  so `limit=15` is 45 jobs ≈ 3 waves — raise `wait_minutes` accordingly or
  accept that the last wave imports on the next run.
- Runs serialize on the `indexer` concurrency group, so back-to-back
  dispatches queue rather than overlap. Re-dispatching a commit whose
  archive already landed is skipped; one still in flight is dispatched
  again (harmless — same key in R2 — but wasted).

**Reading `commits.committed_at`.** It is the **nixpkgs commit date**, not
when the row was imported. A head at seq 2795 dated 2026-09-14 on 09-17 is
"caught up to the newest release", not "three days behind" — this confused a
status check on 2026-09-17. Import time is `commit_systems.imported_at`.

---

## Phase 5 — go live

- [ ] Add the domain in Vercel, set the DNS records at the registrar. Until
      then the service answers on `devbox-search.vercel.app`, which works fine
      as a `DEVBOX_SEARCH_HOST` value.
- [ ] Verify TLS and that `/readyz` returns `ok`
- [ ] Re-run the shadow diff against the real domain
- [ ] Announce the `DEVBOX_SEARCH_HOST` value for anyone who wants to use it

---

## Things learned the hard way (2026-09-16/17)

Debugging the first 35 failed `index` runs, and then the first real imports,
surfaced these. Each one either produced a misleading error or no error at all.

**The workflow, in the order things failed:**

- **Missing secrets look like a local Postgres.** An unset GitHub secret
  expands to `""`, and `pg` treats an empty connection string as
  `localhost:5432` — so a missing `DATABASE_URL_DIRECT` surfaced as
  `ECONNREFUSED 127.0.0.1:5432` for a month. Fixed in #11 (`||` not `??`);
  it now says `missing required environment variable`.
- **`discover` on an empty database walks to the beginning of time.** With no
  imported commits, `headCommitCount` is 0 and it picks the *oldest* release
  in the nix-releases bucket (a 2017 commit whose 7-char hash GitHub can't
  resolve → `422`). The seed must run first. #15 (PR #33) makes it bail with
  "no commits in database — run the seed first" instead.
- **`import` with zero artifacts crashed.** `download-artifact` doesn't
  create the target dir when nothing matched, and `readdirSync` threw
  `ENOENT` — defeating the `if: always()` "import whatever succeeded" design.
  Fixed in PR #12: missing dir == no archives.
- **Jobs on an unavailable runner label queue forever.** No error, no
  timeout. Same symptom for a $0 Actions budget. If `eval` sits in `queued`
  for more than a couple of minutes, it's one of those two.
- **The runner image changes.** `ubuntu-latest` now ships an active 4 GB
  `/swapfile` (`fallocate: Text file busy`), and `/mnt` isn't a separate
  disk, so a blind 16 GB fallocate filled `/` and killed the runner with
  `No space left on device` from its *own* diag log. The swapfile step now
  sizes itself from `df`.
- **nixpkgs 26.11 dropped `x86_64-darwin`.** `nix-env` errors out evaluating
  it, so it was removed from `SYSTEMS` in `index.yml` and rejected up front
  by `eval.yml` (#12/#13, devbox-search-indexer #4). The seed still holds
  x86_64-darwin variants for all 2,751 historical commits with their ranges
  open; they never advance past seq 2751. **Decision (#17): leave it.** The
  DB keeps the seeded x86_64-darwin rows exactly as they are, and the indexer
  appends nothing new for that system — so any query for x86_64-darwin
  returns the seed-era state and nothing later. x86_64-darwin is effectively
  deprecated. Don't close the ranges and don't add it back to `SYSTEMS`.
  **`i686-linux` is in the same state** — seeded through seq 2751,
  never in the indexer's system list — and gets the same treatment.
- **A Linux eval is ~575 MB of JSON**, past V8's 536 MB string cap, so
  `JSON.parse(readFileSync(...))` throws `Cannot create a string longer than
  0x1fffffe8 characters`. The importer stream-parses with `stream-json` (#13).
- **A commit with one system imported looked done.** `discover` only compared
  hashes, so a day where two of three evals failed was never revisited.
  `commit_systems` + `discover --systems` re-list a known commit missing a
  system (#13).

**The eval output:**

- **Newer Nix lists `meta.broken` packages as stubs.** Nix ≥ 2.2x emits a
  package whose derivation refuses to evaluate (broken without `allowBroken`,
  unsupported system) with only `name`/`pname`/`version` — no outputs, no
  meta. The Nix behind the seed's compact DB dropped those, so the ported
  decoder had never seen one. The first two real imports (seq 2752/2753) each
  wrote **~75k phantom variants and ~11k fake packages** (`haskellPackages.*`,
  `rPackages.*`) with `broken=false`. `decodeEvalJson` now skips anything
  without a store path (#19), `importEval` refuses an eval containing one, and
  `variants.store_hash` has a `CHECK (<> '')` (#21, migration `0002`).
  **Two manual staging cleanups were needed (2026-09-16 and 2026-09-17)**
  because the cron ran once more with the old decoder between the fix
  landing and the cleanup — if the decoder changes again, pause the cron
  first. Also why `nix_version` is recorded per import (#22).

**The seed:**

- **`semver_major/minor/patch` had to be `bigint`.** nixpkgs has 99
  strict-semver versions with a date-stamped component (`3.1.20220119140128`,
  widest 14 digits) that overflow int4; `parseSemver` accepts up to 2^53.
  Migration `0001_semver_bigint`, applied to `main` (the only branch) on 2026-09-17.
  The importer's temp `stage_versions` table was missed and stayed `integer`
  until #30 (first real hit: `8b7dc2ca` with `0.1.20260720092025`, during
  the #20 catch-up). Any new temp/staging DDL must mirror the real types.
- **`commit_systems.nix_version`** (migration `0003_commit_systems_nix_version`,
  #22) records which Nix produced each imported archive. **A migration
  merged is not a migration applied**: on 2026-09-17 evening staging was
  still at `0001` with `0002`/`0003` unapplied while #23 (which writes the
  column) was on `main`. Neon `main` was at `0003` with 2,795 commits by
  then (restored from staging — see the `main_empty_pre_restore` branch).
  `migrate.yml` (#37) exists so this cannot recur (staging itself was retired
  the same day — see [Single branch](#single-branch-since-2026-09-17)).
- **The PGlite test suites had `0000_init.sql` hardcoded**, so a second
  migration would never have been tested. They now apply the journal.
- **Migration `0002_variants_store_hash_check`** (#21): `CHECK (store_hash
  <> '')` on `variants`, and the `''` default dropped. Backstop for the #19
  stubs, which reached the DB as ~75k phantom variants per commit before the
  decoder skipped them; the importer now also refuses an eval containing one.
  Applied to `main` (`db migrate`, as above). `ADD CONSTRAINT` scans the table under an exclusive lock — seconds at 3.8M rows,
  but don't run it mid-import.
- The staging seed took ~10 minutes on default Neon compute. The "bump
  compute" step is unnecessary.

**Local tooling:**

- `aws` CLI older than 2.13 silently ignores `AWS_ENDPOINT_URL` and sends R2
  requests to real AWS S3, which then reports `InvalidAccessKeyId`. Pass
  `--endpoint-url` explicitly when testing R2 locally. The runner's CLI is
  current, so `index.yml` is fine.
- A shell profile that exports `AWS_REGION` overrides `AWS_DEFAULT_REGION`;
  R2 needs `auto`.
- `vercel link` drops a `.env.local` (with real credentials) in the repo root.
  Delete it.

---

## Deferred / optional

- **Eval archive from Jetify** — time-sensitive but not blocking. If anyone at
  Jetify can export `s3://nixpkgs-metadata` before shutdown, grab it: it's the
  only way to backfill real `variant_ranges` history. Without it, ranges are
  point-only for everything before migration day, so hash-coverage features are
  authoritative only from then forward. Worth one email; not worth waiting on.
- **`search.devbox.sh` handoff** — only needed if we later want *shipped* CLIs
  (no env var) to hit the new service. That's a Jetify CNAME or a devbox
  release changing the default host.
- **New endpoints** — hash-coverage and constraint queries. The schema already
  supports them, so these are purely additive after cutover.

---

## Cost after cutover

| Item | Monthly |
|---|---|
| Neon Launch | ~$5–22 (storage ~$1.40, compute varies with CDN hit rate) — billed through Vercel, not a separate Neon account |
| Vercel | $0 incremental (already paid) |
| Eval runners | **$0** — public `devbox-search-indexer` repo, unlimited minutes (~14 job-minutes per commit) |
| GitHub standard runners (discover/import, this repo) | **$0** — ~15–30 min/day including the wait for evals (#14), well inside the Pro plan's 3,000 included minutes |
| R2 eval archive | $0 (free 10 GB ≈ 3–5 years of archives) |
| **Total** | **~$5–22/mo**, all Neon |

The GitHub Actions **budget** matters as much as the plan: a $0 Actions budget
with "stop usage" on silently prevents any paid-minute job from being
scheduled — it queues forever, no error. It was $0 until 2026-09-16 (now $50).
Already-queued jobs are not re-evaluated when the budget changes; cancel and
re-trigger.

This repo stays private (see the runner decision at the top). If that ever
changes: history was scanned clean on 2026-09-16 (all remote branches; the
only hits were in local Conductor checkpoint refs that never reach GitHub) and
the Claude workflows are already owner-gated.
