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
- **Runners:** use [Blacksmith](https://blacksmith.sh) for the eval job rather
  than GitHub larger runners. GitHub's larger runners require a Team or
  Enterprise plan, which a personal private repo doesn't have; Blacksmith
  attaches as a GitHub App, works on private repos, and costs roughly half.
  See [Phase 0](#phase-0--unblock-do-these-first) for what to verify.

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
them. 0.3 and 0.4 are **done**; only Blacksmith (0.1, 0.2) is outstanding, and
it gates nothing before Phase 4.

### 0.1 Set up Blacksmith

- [ ] Install the Blacksmith GitHub App on the repo
- [ ] Confirm the current runner labels and specs at blacksmith.sh — they
      change, so don't trust a label copied from here. Expect the form
      `blacksmith-4vcpu-ubuntu-2204` / `-8vcpu-`.
- [ ] Confirm **RAM** on the tier you pick. The eval needs ~16 GB; Blacksmith
      generally gives more RAM per vCPU than GitHub, so a 4-vCPU tier is the
      starting point and 8-vCPU is the fallback.
- [ ] Confirm per-minute price to sanity-check the cost table below.

Then update `.github/workflows/index.yml` on `main` (line 57, currently an
`ubuntu-latest` / `ubuntu-latest-4-cores` visibility expression):

```yaml
  eval:
    runs-on: blacksmith-4vcpu-ubuntu-2204   # was: the ubuntu-latest-4-cores expression
```

Keep the swapfile step. It's ~10 seconds and it's cheap insurance against an
eval that grows past RAM.

### 0.2 Prove the eval fits in memory

`eval-experiment.yml` is already on `main`, so its `workflow_dispatch` is live
in the Actions tab and takes the runner label as an input.

- [ ] Run **eval-experiment** from the Actions tab with a recent nixpkgs commit
      hash and the Blacksmith label
- [ ] Record peak RSS, wall time, and output size from the job log

This gates the whole indexer design. If it OOMs, the ordered fallbacks are:
`nix-eval-jobs --workers 2 --max-memory-size 6000` (needs an output adapter),
a bigger Blacksmith tier, then a self-hosted runner (Hetzner ~€6/mo).

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

- [ ] Apply the Blacksmith `runs-on` change from 0.1
- [x] Merge PR #7
- [ ] Point the workflow at **staging** and soak for ~1 week

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
| Blacksmith (eval) | ~$30–60 — **verify current pricing**; roughly half GitHub's larger runners |
| GitHub standard runners (discover/import) | ~$5–15, largely inside the Pro plan's free minutes |
| R2 eval archive | $0 (free 10 GB) |
| **Total** | **~$40–100** |

Making the repo public would drop the runner lines to $0 (public repos get free
4-vCPU/16-GB runners), taking the total to ~$5–22. Worth revisiting once the
migration is done and there's nothing sensitive in the history.
