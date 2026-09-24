# devbox-search

The open-source search service for [devbox](https://github.com/jetify-com/devbox):
the API the devbox CLI calls to resolve packages (`python@3.11` → nixpkgs
commit hash + attribute path) and to search nixpkgs. It replaces the original
closed-source Go service behind `search.devbox.sh`, and the v1/v2 HTTP APIs
stay byte-compatible with it so shipped CLIs keep working.

The same index is browsable at [nixsearch.com](https://nixsearch.com): every
version of every package, on every system, with the commit that ships it
(`/pkg/python`, `/search?q=go`, `/pkg/python/3.11.9`). See
[docs/website.md](docs/website.md).

Indexing runs on GitHub Actions (every nixpkgs-unstable release, minutes after
it lands), data lives in Postgres (incremental-forever, never rebuilt), and the
API is a Next.js app. Production runs on Neon + Vercel at
https://nixsearch.com; point a CLI at it with
`DEVBOX_SEARCH_HOST=https://nixsearch.com`.

## Layout

```
packages/core/      pure domain logic: canonical names, version ordering +
                    sort keys, normalization, eval JSON decoding + hashing
packages/db/        Drizzle schema + migrations (Postgres)
packages/indexer/   commit discovery, nix-env eval, incremental import, seed
apps/web/           Next.js route handlers: app/v1, app/v2 (the API),
                    app/(site) (the website), lib/site (its rendering)
eval.nix            the expression nix-env evaluates in CI
tools/              one-off scripts (shadow corpus recorder, ...)
docs/apis/          HTTP API reference: openapi.yaml (source of truth) and
                    the generated README.md
docs/operations.md  how the daily pipeline runs, and what has broken before
docs/self-hosting.md  running your own copy
docs/website.md     the nixsearch.com website: routes, pages, what it renders
```

## Development

[devbox](https://www.jetify.com/devbox) provides the whole toolchain (Node,
pnpm, psql, aws, jq); nothing else needs installing.

```sh
devbox shell         # or `devbox run <script>` for one-offs
devbox run setup     # pnpm install + build every package
devbox run check     # lint, typecheck, all workspace tests
devbox run env:setup # write .env (Vercel if linked, else from .env.example)
devbox run dev       # env:setup, then next dev on http://localhost:3000
```

`dev` runs `env:setup` first, so a fresh checkout either comes up against a
real database or stops and says what is missing. `.env` is loaded into every
`devbox run` script (`env_from`), and is never overwritten once it exists —
edit it freely, or export `DATABASE_URL` in your shell to bypass it.

`pnpm test`, `pnpm lint` and `pnpm typecheck` work as usual inside the shell.
The unit suite needs no database: the query tests run against PGlite in
process.

Every Vercel deployment is also exercised end to end by
`.github/workflows/integration.yml` as soon as it is ready; the same script
runs against any URL:

```sh
BASE_URL=https://nixsearch.com node --test tools/integration.test.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes flow, and
[docs/operations.md](docs/operations.md) for the pipeline.

## API documentation

`docs/apis/openapi.yaml` describes every endpoint; `docs/apis/README.md` is
generated from it, with example responses captured by running the route
handlers against the test fixture:

```sh
devbox run gen-api-docs
```

`apps/web/lib/apiDocs.test.ts` fails when a `route.ts` is missing from the
spec or the README is stale, so `pnpm test` keeps the docs honest.

## Version ordering

The original Go service compared versions with a semver → PEP 440 →
simple-split cascade that was not transitive. This port replaces it with a
single clean total order (close to Nix's `builtins.compareVersions`, with
prerelease tags sorting below their release) that is encoded into a
byte-comparable `sort_key`, so version order is a plain `ORDER BY sort_key`
in SQL. See `packages/core/src/version.ts` for the full ordering rules and
the intentionally-diverged Go test vectors.

`latest` is not simply `max(sort_key)`: nixpkgs versions snapshots as dates
(`2017-03-30`), which compare above any numeric release, and no string rule
can tell an old snapshot from a new one (go-font went `2017-03-30` → `2.010`,
mod_python went `3.5.0` → `2022-10-18`). `apps/web/lib/search.ts` instead
asks `variant_ranges` which versions nixpkgs still has: `latest` is the
highest version present in the newest import (falling back to the most
recently present one), preferring a non-broken one. Seeded point ranges
carry no presence information and are ignored.

## License

[Apache-2.0](LICENSE). `packages/core` is a port of the original Go
service's domain logic; the v1/v2 API shape is its contract.
