#!/usr/bin/env bash
#
# Make sure this checkout has the connection strings the app needs, and say
# plainly what is missing when it cannot.
#
# `devbox run dev` runs this first. Without it a fresh checkout starts a
# server that answers every request with a 500, because nothing in the repo
# reads a dotenv file on its own and `next dev` runs from apps/web, where a
# root .env is not on its search path. With it, `dev` either has a database
# or stops with an instruction.
#
# In order of preference:
#
#   1. DATABASE_URL already exported — the "or export in your shell" path in
#      .env.example. Nothing to do.
#   2. .env already exists. Never overwritten: it may hold hand-edited or
#      self-hosted values. devbox's `env_from` loads it for every script.
#   3. This checkout is linked to a Vercel project (.vercel/project.json, as
#      `vercel link` leaves it). Pull that project's values.
#   4. Otherwise: leave a .env from the example and stop, because its
#      placeholders do not point at a database.
#
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=.env
EXAMPLE=.env.example
# The host in .env.example, i.e. "this was never filled in".
PLACEHOLDER='user:password@host'
# All Vercel environments point at the same Neon branch, so `development` is
# both the honest choice for a dev script and the same database.
VERCEL_ENV=${VERCEL_ENV_TARGET:-development}

say() { printf 'env: %s\n' "$1" >&2; }

# A file is usable when it names a DATABASE_URL that isn't the example's.
usable() {
  grep -qE '^DATABASE_URL=.' "$1" && ! grep -q "$PLACEHOLDER" "$1"
}

# 1. Exported in the shell.
if [ -n "${DATABASE_URL:-}" ]; then
  say "using DATABASE_URL from the environment"
  exit 0
fi

# 2. Already configured.
if [ -f "$ENV_FILE" ]; then
  if usable "$ENV_FILE"; then
    say "using $ENV_FILE"
    exit 0
  fi
  say "$ENV_FILE has no real DATABASE_URL yet — fill it in (see docs/self-hosting.md)"
  exit 1
fi

# 3. A linked Vercel project. Only ever `pull`, never `link`: linking drops a
#    stray .env.local in the repo root and edits .gitignore.
if [ -f .vercel/project.json ] && command -v vercel >/dev/null 2>&1; then
  say "no $ENV_FILE; pulling the $VERCEL_ENV environment from Vercel"
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT
  tmp=$tmp_dir/env
  if vercel env pull --environment="$VERCEL_ENV" "$tmp" >/dev/null 2>&1 && usable "$tmp"; then
    # Neon publishes the unpooled string as DATABASE_URL_UNPOOLED; the
    # indexer and migrate read it under the name DATABASE_URL_DIRECT.
    if ! grep -q '^DATABASE_URL_DIRECT=' "$tmp" && grep -q '^DATABASE_URL_UNPOOLED=' "$tmp"; then
      unpooled=$(grep -m1 '^DATABASE_URL_UNPOOLED=' "$tmp" | cut -d= -f2-)
      printf 'DATABASE_URL_DIRECT=%s\n' "$unpooled" >>"$tmp"
    fi
    cp "$tmp" "$ENV_FILE"
    say "wrote $ENV_FILE (gitignored)"
    exit 0
  fi
  say "vercel env pull did not return a DATABASE_URL — falling back to $EXAMPLE"
fi

# 4. Nothing to pull from.
cp "$EXAMPLE" "$ENV_FILE"
say "wrote $ENV_FILE from $EXAMPLE — set DATABASE_URL in it, then run this again"
say "any Postgres 17 works; docs/self-hosting.md has the details"
exit 1
