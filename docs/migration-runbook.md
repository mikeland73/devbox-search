# devbox-search migration runbook

Operational checklist for moving `devbox-search` off Jetify's axiom infra onto
Neon + Vercel + GitHub Actions. Tick items off as you go.

The code lands as five stacked PRs (#3 core → #4 schema → #5 seed → #6 API →
#7 indexer). This file tracks the things **outside** the code: accounts,
credentials, decisions, and the order to do them in.

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

## Phase 0 — unblock (do these first)

These three are independent of each other and of PR review. Everything else
waits on them.

### 0.1 Set up Blacksmith

- [ ] Install the Blacksmith GitHub App on the repo
- [ ] Confirm the current runner labels and specs at blacksmith.sh — they
      change, so don't trust a label copied from here. Expect the form
      `blacksmith-4vcpu-ubuntu-2204` / `-8vcpu-`.
- [ ] Confirm **RAM** on the tier you pick. The eval needs ~16 GB; Blacksmith
      generally gives more RAM per vCPU than GitHub, so a 4-vCPU tier is the
      starting point and 8-vCPU is the fallback.
- [ ] Confirm per-minute price to sanity-check the cost table below.

Then update `.github/workflows/index.yml` on PR #7's branch:

```yaml
  eval:
    runs-on: blacksmith-4vcpu-ubuntu-2204   # was: the ubuntu-latest-4-cores expression
```

Keep the swapfile step. It's ~10 seconds and it's cheap insurance against an
eval that grows past RAM.

### 0.2 Prove the eval fits in memory

`workflow_dispatch` only shows up once the workflow is on the default branch,
so put it there first:

```sh
git checkout main && git cherry-pick 7e9365c && git push
```

- [ ] Run **eval-experiment** from the Actions tab with a recent nixpkgs commit
      hash and the Blacksmith label
- [ ] Record peak RSS, wall time, and output size from the job log

This gates the whole indexer design. If it OOMs, the ordered fallbacks are:
`nix-eval-jobs --workers 2 --max-memory-size 6000` (needs an output adapter),
a bigger Blacksmith tier, then a self-hosted runner (Hetzner ~€6/mo).

### 0.3 Create the Neon project

- [ ] Sign up / upgrade to **Launch** (the free tier's 0.5 GB doesn't fit ~4 GB)
- [ ] Create the project, then create a **staging branch** — free, and it's the
      test environment for every phase below
- [ ] Collect **both** connection strings per branch:
      - `DATABASE_URL` — pooled, for the Vercel app
      - `DATABASE_URL_DIRECT` — **unpooled**, for seed and import

> The unpooled string is not optional. COPY and session-level advisory locks do
> not work through Neon's pooler (transaction-mode pgbouncer).

---

## Phase 1 — core + schema

- [ ] Review and merge **PR #3** (core domain logic — pure logic, no services)
- [ ] Review and merge **PR #4** (schema — pure DDL)
- [ ] Apply migrations to the staging branch:

```sh
DATABASE_URL_DIRECT=<staging-direct> pnpm --filter @devbox-search/db migrate
```

GitHub retargets the stacked PRs automatically as each one merges.

---

## Phase 2 — seed and validate

- [ ] Review **PR #5** (seed)
- [ ] Temporarily bump staging compute (the seed uploads ~1.5 GB)
- [ ] Run the seed **locally**, not in CI:

```sh
DATABASE_URL_DIRECT=<staging-direct> \
  node --max-old-space-size=8192 packages/indexer/dist/seed.ts \
  ~/devbox-search-data/nixpkgs-compact-2026-08-13.db
```

- [ ] Check `seed-report.txt`. Row counts are hard assertions and must match
      exactly:

  | table | expected |
  |---|---|
  | variants | 3,800,488 |
  | versions | 1,445,177 |
  | packages | 248,524 |
  | commits | 2,751 |

- [ ] Spot-check the ordering divergences. These are **expected** (sanctioned
      change #4 replaced a non-transitive comparator) and already enumerated in
      `~/devbox-search-data/ordering-report.txt`: 764,913 pairs across 10,004
      packages, and **0** prerelease divergences. You're sanity-checking that
      the new order is right where it differs, not reading 765k lines.
- [ ] Drop staging compute back down
- [ ] Merge PR #5

---

## Phase 3 — API and the shadow gate

**This is the riskiest phase.** It's the first time the ported query semantics
meet real recorded responses. Budget for a round or two of fixes.

- [ ] Create the Vercel project: root directory `apps/web`
- [ ] Set `DATABASE_URL` (pooled, staging) for the **Preview** environment
- [ ] Deploy a preview from PR #6's branch
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

- [ ] Merge PR #6
- [ ] Bump prod compute, seed the prod branch (same command, prod direct URL),
      drop compute back
- [ ] Set `DATABASE_URL` (pooled, prod) for the **Production** environment and
      promote

At this point the service is live on a frozen dataset. The indexer is not
required for it to be useful.

---

## Phase 4 — indexer

- [ ] Create the Cloudflare R2 bucket (free tier ≈ 3–5 years of eval archives)
- [ ] Add repo secrets:

  | secret | used by |
  |---|---|
  | `DATABASE_URL_DIRECT` | discover, import, status |
  | `R2_ACCESS_KEY_ID` | eval archive upload |
  | `R2_SECRET_ACCESS_KEY` | eval archive upload |
  | `R2_ENDPOINT` | eval archive upload |
  | `R2_BUCKET` | eval archive upload |

- [ ] Apply the Blacksmith `runs-on` change from 0.1
- [ ] Merge PR #7
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

- [ ] Add the domain in Vercel, set the DNS records at the registrar
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
| Neon Launch | ~$5–22 (storage ~$1.40, compute varies with CDN hit rate) |
| Vercel | $0 incremental (already paid) |
| Blacksmith (eval) | ~$30–60 — **verify current pricing**; roughly half GitHub's larger runners |
| GitHub standard runners (discover/import) | ~$5–15, largely inside the Pro plan's free minutes |
| R2 eval archive | $0 (free 10 GB) |
| **Total** | **~$40–100** |

Making the repo public would drop the runner lines to $0 (public repos get free
4-vCPU/16-GB runners), taking the total to ~$5–22. Worth revisiting once the
migration is done and there's nothing sensitive in the history.
