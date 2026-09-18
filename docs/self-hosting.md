# Self-hosting

Running your own copy: a Postgres database, a fork of this repository for
the indexer, and somewhere to run the Next.js app. Production uses Neon and
Vercel, but nothing below requires them except where noted.

You start from an empty database. The index is incremental-forever, so your
copy begins at whatever nixpkgs commit you bootstrap with and grows from
there; it will not contain history from before that commit.

> **Caveat, tracked in [#54](https://github.com/mikeland73/devbox-search/issues/54):**
> the API's serving client speaks Neon's HTTP protocol only, so the database
> has to be a Neon one for now. The indexer works against any Postgres.

## 1. Postgres

Any Postgres 17 (Neon, see above). You need **two** connection strings:

| Variable | Used by | What |
|---|---|---|
| `DATABASE_URL` | the API (`apps/web`) | may be a pooled endpoint; every query is standalone |
| `DATABASE_URL_DIRECT` | indexer, `migrate` | **must be a direct (unpooled) connection** — `COPY` and session-level advisory locks do not work through a transaction-mode pooler such as pgbouncer or Neon's pooled endpoint |

On Neon these are the `DATABASE_URL` and `DATABASE_URL_UNPOOLED` values it
publishes; the second is used here under the name `DATABASE_URL_DIRECT`.
Storage grows roughly 1–2 GB per year of daily imports; Neon's free tier
(0.5 GB) covers the first few months.

`.env.example` lists everything.

## 2. Schema

```sh
devbox shell
devbox run setup
DATABASE_URL_DIRECT=<direct-url> devbox run migrate
```

Prints `applied N …` the first time and `up to date` afterwards. In the
fork, `migrate.yml` does the same on every merge to `main` that touches
`packages/db/drizzle/`, using the `DATABASE_URL_DIRECT` repository secret.

## 3. Fork and set secrets

Fork the repository and set these repository secrets:

| Secret | Required | Purpose |
|---|---|---|
| `DATABASE_URL_DIRECT` | yes | discover, import, migrate |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` | no | archive every eval to an S3-compatible bucket (`{system}/{unix-seconds}-{hash}.json.gz`). Without it evals travel between jobs as workflow artifacts and nothing is kept; with it, a commit is never evaluated twice and a fresh database can import history. Any S3-compatible store works; the endpoint is not hardcoded. |

The eval needs the 4-vCPU/16 GB runners that GitHub gives **public**
repositories; on a private repository's 2-vCPU/7 GB runners `nix-env` does
not fit even with swap (it thrashes for half an hour and the VM is killed).
Keep the fork public, or use a self-hosted runner with ≥16 GB.

## 4. Bootstrap: the first commit

The daily run discovers "releases newer than the database head", so an
empty database has no head and `discover` refuses to run. The first commit
is imported by hand: evaluate it in the fork, download the result, import it
locally.

**The commit must be a nixpkgs-unstable channel release**, not an arbitrary
nixpkgs commit — `discover` anchors on the head by finding it in the
channel's release list. The `nixpkgs-unstable` branch head is always the
current release:

```sh
gh api repos/NixOS/nixpkgs/commits/nixpkgs-unstable \
  --jq '"commit=\(.sha)\ncommitted_at=\(.commit.committer.date)"'
```

Evaluate it (three jobs, ~5 minutes wall clock):

```sh
gh workflow run eval.yml -f commit=<sha> -f committed_at=<date>
gh run list --workflow=eval.yml --limit 1        # note the run id
gh run watch <run-id>
```

Download the three `eval-{system}-{hash}` artifacts into the layout the
importer reads, and import:

```sh
gh run download <run-id> --pattern 'eval-*' --dir evals
DATABASE_URL_DIRECT=<direct-url> devbox run index import --dir evals
```

Each system prints `imported <hash>/<system> as seq 1: …`. Every variant in
this first import is "new" by definition — a change ratio warning is not
expected and would not fire. With the archive configured, `eval.yml` has
also written the three objects to the bucket, so the import could equally
have been done on a runner.

From here the database has a head, and everything is automatic:

```sh
gh workflow run index.yml -f limit=4
```

The schedule (05:00 UTC daily) takes over from there. `docs/operations.md`
describes a run and the things to watch.

## 5. API

`apps/web` is a plain Next.js app; it needs `DATABASE_URL` and nothing else.

On Vercel: import the fork, set **Root Directory** to `apps/web`
(`apps/web/vercel.json` carries the install and build commands), add
`DATABASE_URL`. Turn Deployment Protection off if you want preview URLs
usable from a `devbox` CLI (it cannot send a bypass header), and leave Git
Fork Protection on.

Anywhere else:

```sh
DATABASE_URL=<url> pnpm --filter @devbox-search/web... build
cd apps/web && DATABASE_URL=<url> pnpm exec next start
```

Check it: `/readyz` → `ok`, `/v2/resolve?name=hello&version=latest`,
`/status` for the index head and per-system state. Then run the integration
suite against it:

```sh
BASE_URL=https://your-host node --test tools/integration.test.mjs
```

Some of those tests pin resolutions that only an index with history can
satisfy (`go@1.22` left nixpkgs in 2025); expect them to fail on a freshly
bootstrapped copy.

## 6. Point a CLI at it

```sh
DEVBOX_SEARCH_HOST=https://your-host devbox add python@3.11
```
