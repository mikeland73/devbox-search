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
- **Runners (revised 2026-09-16):** neither of the original plans is available
  to a personal account. GitHub's larger runners (`ubuntu-latest-4-cores`)
  need a Team/Enterprise org — on a personal private repo the jobs **queue
  forever** rather than failing, so a stuck `queued` eval is this, not a
  capacity blip. Blacksmith also doesn't support personal accounts. The
  order of preference now:
  1. ~~**Standard free `ubuntu-latest` (2 vCPU / 7 GB) plus swap**~~ —
     **tested 2026-09-16, does not fit** (see 0.2). And it wouldn't have been
     free anyway: 4 evals/day blows past the Pro plan's 3,000 included minutes.
  2. **Make the repo public** — free 4-vCPU/16 GB runners, unlimited minutes.
     `index.yml` already switches on `repository_visibility`. History was
     scanned 2026-09-16 and is clean; the Claude workflows are gated to the
     owner so strangers can't spend the OAuth token. Downside: the half-built
     migration is visible.
  3. **Vercel Sandbox** (Pro: 8 vCPU / 16 GB, 24 h sessions, ~$0.47 per
     eval-hour → ~$36–92/mo net of the $20 credit). Fits only if peak RSS is
     comfortably under 16 GB with no swap. Would need the eval to run detached
     and `import` to read from R2 instead of workflow artifacts.
  4. **Self-hosted runner** (Hetzner ~€6/mo) — the private-repo fallback.

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
| Neon branches | `main` (default, = prod) and `staging` |
| Neon dashboard | `vercel integration open neon devbox-search-db` (SSO) |

`neonctl` works against this project — the Vercel-managed org shows up after
`neonctl auth`. Every command needs the org or project id, otherwise it prompts:

```sh
npx neonctl projects list --org-id org-frosty-butterfly-42439211
npx neonctl branches list --project-id autumn-rain-65994722
npx neonctl connection-string staging --project-id autumn-rain-65994722 [--pooled]
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

Which Neon branch each Vercel environment points at:

| Vercel env | Neon branch | Record owner |
|---|---|---|
| Production, Development | `main` | the integration |
| Preview | `staging` | **manual override** |

The integration's own records were narrowed to `production,development` and
plain preview-scoped records added alongside — Vercel rejects two records with
the same key and overlapping targets, so the narrowing is required, not
cosmetic. Consequence: if the integration ever re-syncs and re-widens its
records back to all three environments, Preview silently starts pointing at
prod. Re-check with `vercel env pull --environment=preview` before trusting a
shadow-diff run.

`vercel env pull --environment=preview` is the right way to get the staging
credentials for a local seed — don't copy them out of the Neon console.

---

## Phase 0 — unblock (do these first)

These are independent of each other and of PR review. Everything else waits on
them. 0.3 and 0.4 are **done**; the runner question (0.1, 0.2) is the only
thing outstanding and it blocks Phase 4's first real eval.

### 0.1 Pick a runner — ~~Blacksmith~~ (not available to personal accounts)

Blacksmith is out (no personal-account support, confirmed 2026-09-16), as are
GitHub larger runners. See the revised runner decision at the top. What to do
depends on 0.2:

- [ ] If the eval **fits on `ubuntu-latest` + swap**: change `index.yml`'s
      `eval.runs-on` to plain `ubuntu-latest` and stay private. Expect each
      eval to be slow (2 vCPU, heavy swapping) — check it lands inside the
      180-minute job timeout with margin.
- [ ] If it doesn't: make the repo public (`gh repo edit --visibility public`
      **after** PR #12 merges, so the owner-gated Claude workflows are live on
      `main` first). `index.yml` needs no change.
- [ ] Only if neither works: Vercel Sandbox or a Hetzner self-hosted runner.

The swapfile step now sizes itself from free space; don't hardcode a path or
size again — see "Things the runner image taught us" below.

### 0.2 Prove the eval fits in memory

`eval-experiment.yml` takes the runner label as a `workflow_dispatch` input.
Dispatch it from the branch that has the adaptive swapfile step (PR #12, or
`main` once merged).

- [x] Run **eval-experiment** on `ubuntu-latest` — run 35136891482,
      `x86_64-linux` at `6b5e5b7a` (2026-09-16); earlier attempts died on the
      swapfile step, see below
- [x] Result: **does not fit.** Runner had 7.8 GB RAM, 2 vCPU, 14 GB free
      disk → 8.4 GB swap total. `nix-env` ran 36 min, then GitHub killed the
      VM (`exit 143`, "runner has received a shutdown signal") — the
      swap-thrash signature, not the 180-min timeout. Peak RSS unrecorded
      but >7.8 GB and not sustainable on 8 GB of swap. Option 1 is out.
- [ ] Decide 0.1 from what's left: public repo (16 GB + swap) is the only
      free option; Vercel Sandbox's 16 GB with no swap is risky given the
      eval clearly needs well over 8 GB.

If it OOMs even with swap, the ordered fallbacks are: make the repo public
(16 GB + swap), `nix-eval-jobs --workers 2 --max-memory-size 6000` (needs an
output adapter), Vercel Sandbox, then a self-hosted runner.

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
- [x] **staging branch** created off `main`. The Vercel CLI manages the
      resource, not the branches inside it, so this is `neonctl`:

```sh
npx neonctl branches create --project-id autumn-rain-65994722 \
  --name staging --parent main
```

  A Neon branch is copy-on-write, so `staging` came up already holding the
  migrated schema — no second `migrate` run needed.

- [x] **Preview** repointed at staging (see [Env vars](#env-vars); all three
      environments shared the prod branch out of the box, which is wrong once
      prod holds real data)

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

For any **future** migration, both branches have to be done separately —
branching is a point-in-time copy, not ongoing replication:

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
- [ ] Bump prod compute, seed the prod branch (same command, prod direct URL),
      drop compute back
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
  — **for the staging branch first**, switched to prod at the end of this
  phase. Pull it with `vercel env pull` rather than copying it from the
  console.

- [ ] Apply the `runs-on` decision from 0.1
- [x] Merge PR #7
- [x] Point the workflow at **staging** — `DATABASE_URL_DIRECT` is the
      staging direct URL (set 2026-09-16). `discover` now works end to end:
      run 35133999914 picked `6b5e5b7a` (2026-08-13), the first release after
      the seed head, exactly as designed. The eval jobs are what's blocked.
- [ ] Soak for ~1 week once eval runs

  Daily sanity checks:
  - new commits appear and `commit_systems` fills in for all 4 systems
  - ranges open and close in plausible numbers
  - changed variants per day is **low tens of thousands** — millions would mean
    content hashes disagree with the seed, i.e. the importer and seed are
    hashing differently

- [ ] Switch to **prod** and keep shadow-diffing daily

---

## Phase 5 — go live

- [ ] Add the domain in Vercel, set the DNS records at the registrar. Until
      then the service answers on `devbox-search.vercel.app`, which works fine
      as a `DEVBOX_SEARCH_HOST` value.
- [ ] Verify TLS and that `/readyz` returns `ok`
- [ ] Re-run the shadow diff against the real domain
- [ ] Announce the `DEVBOX_SEARCH_HOST` value for anyone who wants to use it

---

## Things learned the hard way (2026-09-16)

Debugging the first 35 failed `index` runs surfaced these. Each one either
produced a misleading error or no error at all.

**The workflow, in the order things failed:**

- **Missing secrets look like a local Postgres.** An unset GitHub secret
  expands to `""`, and `pg` treats an empty connection string as
  `localhost:5432` — so a missing `DATABASE_URL_DIRECT` surfaced as
  `ECONNREFUSED 127.0.0.1:5432` for a month. Fixed in #11 (`||` not `??`);
  it now says `missing required environment variable`.
- **`discover` on an empty database walks to the beginning of time.** With no
  imported commits, `headCommitCount` is 0 and it picks the *oldest* release
  in the nix-releases bucket (a 2017 commit whose 7-char hash GitHub can't
  resolve → `422`). The seed must run first. Optional hardening: bail with
  "no commits in database — run the seed first".
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

**The seed:**

- **`semver_major/minor/patch` had to be `bigint`.** nixpkgs has 99
  strict-semver versions with a date-stamped component (`3.1.20220119140128`,
  widest 14 digits) that overflow int4; `parseSemver` accepts up to 2^53.
  Migration `0001_semver_bigint`. **Prod needs `db migrate` before its seed.**
- **The PGlite test suites had `0000_init.sql` hardcoded**, so a second
  migration would never have been tested. They now apply the journal.
- **Migration `0002_variants_store_hash_check`** (#21): `CHECK (store_hash
  <> '')` on `variants`, and the `''` default dropped. Backstop for the #19
  stubs, which reached the DB as ~75k phantom variants per commit before the
  decoder skipped them; the importer now also refuses an eval containing one.
  Apply to **both** staging and prod (`db migrate`, as above). `ADD
  CONSTRAINT` scans the table under an exclusive lock — seconds at 3.8M rows,
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
| Eval runners | depends on 0.1: **$0** on `ubuntu-latest` if it fits inside the Pro plan's 3,000 included minutes (it won't — 4 evals × ~2 h daily ≈ 14,000 min → ~$90/mo at $0.008/min), **$0** if the repo is public, ~$36–92 on Vercel Sandbox, ~€6 self-hosted |
| GitHub standard runners (discover/import) | ~$5–15, largely inside the Pro plan's free minutes |
| R2 eval archive | $0 (free 10 GB) |
| **Total** | **~$5–22 public; ~$45–115 private** |

The GitHub Actions **budget** matters as much as the plan: a $0 Actions budget
with "stop usage" on silently prevents any paid-minute job from being
scheduled — it queues forever, no error. It was $0 until 2026-09-16 (now $50).
Already-queued jobs are not re-evaluated when the budget changes; cancel and
re-trigger.

Making the repo public is the cheapest path by a wide margin. History was
scanned clean on 2026-09-16 (all remote branches; the only hits were in local
Conductor checkpoint refs that never reach GitHub). Once PR #12 merges, the
Claude workflows are owner-gated and it's safe to flip.
