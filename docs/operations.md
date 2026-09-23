# Operations

How the pipeline runs day to day, and what has gone wrong before. For
standing up your own copy see [self-hosting.md](self-hosting.md).

## How a day's indexing works

`index.yml` runs at 05:00 UTC (after the nixpkgs-unstable channel typically
advances) and on demand. Three jobs:

1. **discover** — lists releases in the public `nix-releases` bucket newer
   than the database head, plus known commits missing one of `SYSTEMS`
   (`commit_systems` records which pairs have landed). For each pending
   `(commit, system)` it checks the archive; pairs already archived are not
   evaluated again.
2. **eval** — one `eval.yml` call per commit, one job per system, on the
   public-repo 4-vCPU/16 GB runners. Each job is ~2–4 min of `nix-env` plus
   the Nix install, ~4.5 min all in. Output goes up as a workflow artifact,
   and to the archive when the `R2_*` secrets are set.
3. **import** — collects the run's artifacts plus anything archived for the
   pending commits, and imports it. Runs even if some evals failed, so a day
   where one system fell over still imports the other two; the run is then
   marked failed so it shows red, and `discover --systems` re-lists the
   missing pair tomorrow.

Runs serialize on the `indexer` concurrency group (shared with `migrate.yml`
so DDL never runs mid-import) and the importer takes a session advisory lock
as well.

### Catching up a backlog

```sh
gh workflow run index.yml -f limit=15
```

- `discover --limit` counts *all* pending commits, archived-but-unimported
  ones included.
- Evals for all commits in a run happen in parallel; import is ~2 min per
  commit and is the bottleneck. Cap `limit` around 15 to stay inside
  import's 120-minute timeout.
- Back-to-back dispatches queue rather than overlap.

### Reading the numbers

- `commits.committed_at` is the **nixpkgs commit date**, not when the row
  was imported. A head dated three days ago on a day when the channel has
  not advanced is "caught up", not "three days behind". Import time is
  `commit_systems.imported_at`.
- Changed variants per commit is **~1,500–1,800 per system**. ~75k per
  commit means stubs got through (see below); millions would mean content
  hashes disagree with the seed, i.e. the importer and seed hash differently.
- `commit_systems.nix_version` should stay at the pinned `NIX_VERSION` in
  `eval.yml`. A change there without a deliberate bump is the first suspect
  for odd counts.

## Migrations

`migrate.yml` runs on every merge to `main` that touches
`packages/db/drizzle/`, so a PR that ships a migration also ships its
deployment. Dispatch it by hand to confirm a database is current; an
up-to-date one prints `up to date`. Locally:

```sh
DATABASE_URL_DIRECT=<direct-url> devbox run migrate
```

The build step is not optional: `migrate` runs `dist/migrate.js`, and the
`core` → `db` dist chain has to exist first.

**A migration merged is not a migration applied** — that bit us once when a
column the importer wrote was on `main` before the migration had run.
`migrate.yml` exists so it cannot recur. Any new temp/staging DDL in the
importer must mirror the real column types (`stage_versions` stayed `integer`
after `semver_*` went `bigint`, #30).

## Systems

`SYSTEMS` in `index.yml` is `x86_64-linux aarch64-linux aarch64-darwin`.

**`x86_64-darwin` and `i686-linux` are frozen, on purpose (#17).** nixpkgs
26.11 dropped x86_64-darwin and `nix-env` errors out evaluating it. The
seed still holds variants for both systems through the last seeded commit
with their ranges open, and the indexer appends nothing new — so a query for
either returns the seed-era state. Don't close the ranges and don't add them
back to `SYSTEMS`; `eval.yml` rejects them up front.

## The eval

- **Memory.** Peak RSS is ~14.1–14.6 GB on the 15 GB public runner and
  nixpkgs only grows. The adaptive swapfile in `eval.yml` is load-bearing,
  and the run fails if headroom drops under 500 MB so growth shows up as a
  red run rather than a slow one. If it ever stops fitting, the ordered
  fallbacks are `nix-eval-jobs --workers 2 --max-memory-size 6000` (needs an
  output adapter), then a self-hosted runner.
- **The swapfile sizes itself from `df`.** The runner image changes: it now
  ships an active 4 GB `/swapfile` (`fallocate: Text file busy`), and `/mnt`
  isn't a separate disk, so a blind 16 GB fallocate once filled `/` and
  killed the runner with `No space left on device` from its *own* diag log.
- **Newer Nix lists `meta.broken` packages as stubs.** Nix ≥ 2.2x emits a
  package whose derivation refuses to evaluate with only
  `name`/`pname`/`version` — no outputs, no meta. The first real imports
  each wrote ~75k phantom variants and ~11k fake packages before
  `decodeEvalJson` learned to skip anything without a store path (#19);
  `importEval` refuses an eval containing one, and `variants.store_hash`
  has a `CHECK (<> '')` (#21). **If the decoder changes again, pause the
  cron first** — the cron ran once more with the old decoder between the fix
  landing and the cleanup, and that needed a manual cleanup.
- **`eval.nix` makes every top-level derivation visible.** `nix-env` lists
  each derivation once, under whichever attribute path it visits first, so
  `python314` vanished the day `buildbotPackages.python` aliased it (#49).
  The wrapper gives each top-level derivation a fresh attribute set so it is
  listed under its own name too.
- **An alias that nixpkgs still uses internally aborts the eval.**
  `packages-config.nix` turns aliases off, and a reference to a missing
  attribute is an error `nix-env` can't skip. Upstream's own search eval
  never gets that far: it keeps unfree packages disallowed, so the unfree
  check throws first. We allow unfree, so the Linux evals failed from the
  day `cudatoolkit` became an alias (nixpkgs#565306) while
  `haskellPackages.cuda` and its siblings still read it. Look for
  `error: attribute '…' missing` in the eval log, then add the name to
  `shims` in `eval.nix`. The attribute is available during evaluation but
  left out of the output.
- **A Linux eval is ~575 MB of JSON**, past V8's 536 MB string cap. The
  importer stream-parses with `stream-json` (#13); don't `JSON.parse` it.
- Darwin systems evaluate fine on Linux: this is pure evaluation, nothing
  is built.

## The database

- **Use the direct (unpooled) connection for the indexer, seed and
  migrate.** `COPY` and session-level advisory locks do not work through a
  transaction-mode pooler (Neon's pooled endpoint is pgbouncer). The API can
  use either.
- **Missing secrets look like a local Postgres.** An unset GitHub secret
  expands to `""`, and `pg` treats an empty connection string as
  `localhost:5432` — a missing `DATABASE_URL_DIRECT` once surfaced as
  `ECONNREFUSED 127.0.0.1:5432` for a month. `createImportClient` now says
  `missing required environment variable` (#11).
- **`discover` on an empty database refuses to run** (#15): with no imported
  commits it would walk to the oldest release in the bucket. Import the first
  commit by hand (see self-hosting.md, Bootstrap); it has to be a channel
  release commit or discover cannot anchor on it either.
- **`semver_major/minor/patch` are `bigint`.** nixpkgs has strict-semver
  versions with a date-stamped component (`3.1.20220119140128`) that
  overflow int4.
- `ADD CONSTRAINT` scans the table under an exclusive lock — seconds at 3.8M
  rows, but don't run it mid-import (hence the shared concurrency group).
- Branching (Neon) is the right tool for trying a schema change or a risky
  import against real data: branch off the production branch, point a local
  `DATABASE_URL_DIRECT` at it, delete it afterwards. Branches are a
  point-in-time copy, not ongoing replication — each needs its own
  `migrate`.

## GitHub Actions

- **Jobs on an unavailable runner label queue forever.** No error, no
  timeout. Same symptom for a $0 Actions spending limit with "stop usage"
  on. If a job sits in `queued` for more than a couple of minutes, it's one
  of those two. Already-queued jobs are not re-evaluated when the budget
  changes; cancel and re-trigger.
- `download-artifact` doesn't create the target dir when nothing matched;
  the importer treats a missing dir as "no archives" (PR #12).

## Local tooling

- `aws` CLI older than 2.13 silently ignores `AWS_ENDPOINT_URL` and sends R2
  requests to real AWS S3, which then reports `InvalidAccessKeyId`. Pass
  `--endpoint-url` explicitly. (The devbox shell ships a current CLI.)
- A shell profile that exports `AWS_REGION` overrides `AWS_DEFAULT_REGION`;
  R2 needs `auto`.
- `vercel link` drops a `.env.local` (with real credentials) in the repo
  root. It is gitignored; delete it anyway when done.

## Deploys

Every Vercel deployment — the preview of each PR and the production deploy of
`main` — is exercised end to end by `.github/workflows/integration.yml`
(searches, resolves, `/status.json`, error bodies) as soon as Vercel reports it
ready. The same script runs against any URL:

```sh
BASE_URL=https://nixsearch.com node --test tools/integration.test.mjs
```

Deployment Protection is off on the Vercel project: previews must be publicly
reachable because a real `devbox` CLI pointed at one cannot send a bypass
header. Git Fork Protection is on, so pull requests from forks do not deploy.

## Rate limiting

The API is rate-limited by the Vercel WAF, not by the route handlers (the
app has no limiter; the old Go service had one in-process, see
`internal/api/limiter.go` there). Two custom firewall rules on the
`devbox-search` project, evaluated in this order:

1. **`rate-limit-override`** — request header `X-Rate-Limit-Override-Secret`
   equals the shared secret → *bypass*, which skips every later custom rule.
2. **`rate-limit-per-ip`** — path is not `/readyz` (nor `/readyz/`, the
   same route to the app) → *rate limit*: 1000
   requests per 600 s per client IP (fixed window; token bucket is an
   Enterprise feature), 429 over the limit until the window resets.

Things to know:

- The WAF sits in front of the CDN cache, so **cache hits count** — unlike
  the Go limiter, which only saw requests that reached the process. A
  `devbox` run that fans out many `/v2/resolve` calls is counted in full.
  1000/10 min is generous for that reason.
- Counters are per Vercel region; a client whose requests land in several
  regions gets a little more than the limit.
- The 429 is Vercel's, not the plain-text error form the handlers use.
  Shipped `devbox` CLIs only check the status code.
- The bypass skips *our* rules only. Vercel's system-level DDoS mitigation
  still applies to every request, header or not — a fast burst from one IP
  (a couple of hundred requests in a few seconds, in testing) gets that IP
  a `403` with `x-vercel-mitigated: challenge` for a while, and no
  application-level secret clears it. If a trusted client needs to burst,
  add its IP with `vercel firewall system-bypass add <ip>`.
- Rate-limited traffic is free; allowed requests evaluated by the rule are
  billed at $0.50 per million after the plan's included usage.

The rules are reproduced by `tools/firewall.mjs` (`vercel.json` can only
express deny/challenge rules, so this goes through the CLI):

```sh
RATE_LIMIT_OVERRIDE_SECRET=<secret> node tools/firewall.mjs   # stages edits, prints the diff
vercel firewall publish --project devbox-search                # makes them live
```

Re-running is safe: rules are matched by name and left alone when already
up to date. Changing the numbers means editing the constants there, running
it, and publishing.

The secret lives in the firewall rule (visible to anyone with project access
— `vercel firewall rules list --expand`) and, so CI can never be the client
that trips the limit, in the `RATE_LIMIT_OVERRIDE_SECRET` repository secret
that `integration.yml` passes to `tools/integration.test.mjs`. To rotate:
`openssl rand -hex 32`, run the script and publish, then
`gh secret set RATE_LIMIT_OVERRIDE_SECRET`. Any other trusted client sends it
as a request header:

```sh
curl -H "X-Rate-Limit-Override-Secret: $SECRET" https://nixsearch.com/v2/resolve?name=go&version=latest
```

Inspect what the rules are doing with `vercel firewall overview` (or the
Firewall tab of the project) and `vercel firewall rules inspect
rate-limit-per-ip`.

