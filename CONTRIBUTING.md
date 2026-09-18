# Contributing

## Setup

```sh
devbox shell
devbox run setup
devbox run check
```

That is the whole toolchain. `devbox.json` pins Node, pnpm, `psql`, `aws`
and `jq`; the versions match what CI uses.

## Making a change

- Branch from `main`, open a pull request. `ci.yml` runs lint, typecheck and
  the unit suite; every push also gets a Vercel preview that
  `integration.yml` tests end to end.
- Adding or changing an API route: update `docs/apis/openapi.yaml` and run
  `devbox run gen-api-docs`. `apiDocs.test.ts` fails otherwise.
- Adding a migration: `pnpm --filter @devbox-search/db generate` writes it to
  `packages/db/drizzle/`; the PGlite test suites apply the whole journal.
  `migrate.yml` applies it to production on merge.
- Changing the eval (`eval.yml`, `eval.nix`, the Nix pin): check the importer
  against a sample of the new output first. The output shape is `nix-env`
  behaviour and has changed between releases before (#19, #49).
- Changing the query layer: regenerate `docs/query-plans.md` with
  `tools/explain-plans.mjs` and diff the plans.

Comments explain *why*; the code already says what. Keep that density.

## Issues

Bug reports with a request (`/v2/resolve?name=…`) and the expected vs.
actual response are the most useful. For anything touching the pipeline,
`docs/operations.md` lists the failure modes seen so far.
