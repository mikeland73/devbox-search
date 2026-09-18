# devbox-search

Successor to Jetify's axiom/devbox-search, which powers `search.devbox.sh` —
the service the devbox CLI uses to resolve packages (`python@3.11` → nixpkgs
commit hash + attribute path). Indexing runs on GitHub Actions, data lives in
Neon Postgres (incremental-forever, never rebuilt), and the API is served by
Next.js on Vercel. The v1/v2 HTTP APIs stay byte-compatible with the original
Go service so shipped devbox CLIs keep working.

## Layout

```
packages/core/      pure domain logic ported from the Go service:
                    canonical names, version ordering + sort keys,
                    normalization, eval JSON decoding + content hashing
packages/db/        Drizzle schema + migrations (Neon Postgres)
packages/indexer/   commit discovery, nix-env eval, incremental import, seed
apps/web/           Next.js route handlers (v1/v2 API)
tools/              one-off scripts (shadow corpus recorder, ...)
docs/apis/          HTTP API reference: openapi.yaml (source of truth) and
                    the generated README.md
```

## API documentation

`docs/apis/openapi.yaml` describes every endpoint; `docs/apis/README.md` is
generated from it, with example responses captured by running the route
handlers against the test fixture:

```
pnpm --filter @devbox-search/web gen:api-docs
```

`apps/web/lib/apiDocs.test.ts` fails when a `route.ts` is missing from the
spec or the README is stale, so `pnpm test` keeps the docs honest.

## Development

Requires Node >= 22 and pnpm.

```
pnpm install
pnpm test        # all workspace tests
pnpm typecheck
pnpm lint
```

Every Vercel deployment — the preview of each PR and the production deploy of
`main` — is also exercised end to end by `.github/workflows/integration.yml`
(searches, resolves, `/status`, error bodies) as soon as Vercel reports it
ready. The same script runs against any URL:

```
BASE_URL=https://devbox-search.vercel.app node --test tools/integration.test.mjs
```

## Version ordering

The old Go service compared versions with a semver → PEP 440 → simple-split
cascade that was not transitive. This port replaces it with a single clean
total order (close to Nix's `builtins.compareVersions`, with prerelease tags
sorting below their release) that is encoded into a byte-comparable
`sort_key`, so version order is a plain `ORDER BY sort_key` in SQL. See
`packages/core/src/version.ts` for the full ordering rules and the
intentionally-diverged Go test vectors.

`latest` is not simply `max(sort_key)`: nixpkgs versions snapshots as dates
(`2017-03-30`), which compare above any numeric release, and no string rule
can tell an old snapshot from a new one (go-font went `2017-03-30` → `2.010`,
mod_python went `3.5.0` → `2022-10-18`). `apps/web/lib/search.ts` instead
asks `variant_ranges` which versions nixpkgs still has: `latest` is the
highest version present in the newest import (falling back to the most
recently present one), preferring a non-broken one. Seeded point ranges
carry no presence information and are ignored.
