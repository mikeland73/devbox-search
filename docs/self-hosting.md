# Self-hosting

Running your own copy: a Postgres database, a fork of this repository for
the indexer, and somewhere to run the Next.js app. Production uses Neon and
Vercel, but nothing below requires them except where noted.

> **Current caveats, tracked in [#54](https://github.com/mikeland73/devbox-search/issues/54):**
> a fresh database has to be **seeded** before the indexer will run, and the
> seed reads a compact SQLite export of the original service's data that is
> not (yet) redistributed. The API's serving client also speaks Neon's HTTP
> protocol only, so it needs a Neon database today. Until #54 lands, the
> realistic path is a Neon database plus a seed file from us — open an issue
> and ask.

## 1. Postgres

Any Postgres 17. You need **two** connection strings:

| Variable | Used by | What |
|---|---|---|
| `DATABASE_URL` | the API (`apps/web`) | may be a pooled endpoint; every query is standalone |
| `DATABASE_URL_DIRECT` | indexer, seed, `migrate` | **must be a direct (unpooled) connection** — `COPY` and session-level advisory locks do not work through a transaction-mode pooler such as pgbouncer or Neon's pooled endpoint |

On Neon these are the `DATABASE_URL` and `DATABASE_URL_UNPOOLED` values it
publishes; the second is used here under the name `DATABASE_URL_DIRECT`.
Storage is ~4 GB for the full index, so the free tier does not fit.

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

## 3. Seed

The indexer is incremental: it needs a starting point.

```sh
DATABASE_URL_DIRECT=<direct-url> \
  node --max-old-space-size=8192 packages/indexer/dist/seed.js \
  path/to/nixpkgs-compact.db
```

Streams ~3.8M rows over `COPY`; about ten minutes against Neon's default
compute. Row counts are hard assertions and the run writes a
`seed-report.txt`. Seeded ranges are *point* ranges (the compact DB carries
no history), so hash-coverage features are authoritative only from the first
real import forward.

## 4. Indexer

Fork the repository and set these repository secrets:

| Secret | Required | Purpose |
|---|---|---|
| `DATABASE_URL_DIRECT` | yes | discover, import, migrate |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` | no | archive every eval to an S3-compatible bucket (`{system}/{unix-seconds}-{hash}.json.gz`). Without it evals travel between jobs as workflow artifacts and nothing is kept; with it, a commit is never evaluated twice and a fresh database can import history. Any S3-compatible store works; the endpoint is not hardcoded. |

Then enable Actions in the fork and run it once by hand:

```sh
gh workflow run index.yml -f limit=4
```

The schedule (05:00 UTC daily) takes over from there. The eval needs the
4-vCPU/16 GB runners that GitHub gives **public** repositories; on a
private repository's 2-vCPU/7 GB runners `nix-env` does not fit even with
swap (it thrashes for half an hour and the VM is killed). Keep the fork
public, or use a self-hosted runner with ≥16 GB.

`docs/operations.md` describes the run and the things to watch.

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

## 6. Point a CLI at it

```sh
DEVBOX_SEARCH_HOST=https://your-host devbox add python@3.11
```
