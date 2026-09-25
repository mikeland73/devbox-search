# nixsearch.com website

The human-facing side of the index: a package search site that shows what
`/v2/search`, `/v2/pkg` and `/v2/resolve` return, as pages. This document
is the design and the reasoning behind it; the code is
`apps/web/app/(site)/` (routes) and `apps/web/lib/site/` (rendering).

## What the site is for

Today nixsearch.com is an API with one page (`/status`). The data behind it
is more than a package list: every version of every package, on every
system, with the nixpkgs commit that ships it and the attribute path to ask
for. Nothing else on the web answers "which nixpkgs commit has python 3.11.4
on aarch64-darwin, and what do I call it?" — search.nixos.org shows one
channel at one point in time. That question is the site's reason to exist,
and it is the one the devbox CLI asks on every `devbox add`.

So the site is a **version-history browser** with search in front of it,
not a catalogue. Three jobs, in order:

1. Find a package by name or attribute path (`python`, `nodePackages.typescript`).
2. See every version nixpkgs has ever had, and which systems each one is on.
3. Get a pinned reference out — `github:NixOS/nixpkgs/<rev>#<attr>` or
   `devbox add name@version` — for exactly one version.

Non-goals: package contents, dependency graphs, options, build status,
anything nixpkgs-wide that isn't in the index. It only shows what the API
generates.

## Data contract: v2 shapes

Pages render **exactly** the v2 response shapes, produced by the same code
paths (`search()`/`resolve()` + `renderV2*` in `apps/web/lib`), so a page
and its JSON can never disagree. Every page links to the JSON it was built
from.

v1 is equally live — the devbox CLI calls a mix of both and its shapes stay
byte-compatible — but a page should render *one* shape, and v2 is the one
designed for display: per-system detail, `platforms_summary`,
`outputs_summary`, RFC 3339 timestamps, no `omitempty` holes to reason
about. So the site is built on v2 throughout, and links to `/v2/*` JSON.
That is a presentation choice, not a statement about v1.

What v2 gives us per page:

| Page | Endpoint | Fields used |
| --- | --- | --- |
| Search results | `/v2/search?q=` | `name`, `summary`, `last_updated`, `total_results` (≤50) |
| Package | `/v2/pkg?name=` | `summary`, `homepage_url`, `license`, `releases[]` → `version`, `last_updated`, `platforms_summary`, `outputs_summary`, `platforms[]` → `system`, `arch`, `os`, `attribute_path`, `commit_hash`, `date`, `outputs[]` |
| Resolve panel | `/v2/resolve?name=&version=` | `version`, `systems{}` → `flake_installable.ref.rev`, `attr_path`, `last_updated`, `outputs` |
| Home / footer | `/status.json` | `counts`, `newest_commit`, `last_import_at` |

### Additive v2 fields

v2 search results are thin for a results page — no version, no attribute
path, no systems — and v2 has no way to say "this version is marked broken",
though v1 carries `broken`/`insecure`/`description` and the columns behind
them are already in the same joins. Mixing v1 fields into a v2-shaped page
would make the page match neither endpoint, so these were **added**
to v2 (Go-style JSON decoders in shipped CLIs ignore unknown fields, so
this is byte-compatible in the direction that matters: existing fields
unchanged, in both versions).

| Shape | Field | Why |
| --- | --- | --- |
| `V2SearchResult` | `version` (the latest), `attribute_path`, `systems: string[]` | Results page shows what you'd get without a click |
| `V2Release` | `prerelease: bool`, `broken: bool`, `insecure: bool` | Explain why `latest` skipped a version; warn before someone pins it |
| `V2Platform` | `broken: bool`, `insecure: bool` | The grain the flags actually have: which systems are affected |
| `V2Pkg` | `description` (meta.longDescription), `attribute_paths: string[]` | Package page header; the sidebar's "also known as" |

These are the only schema changes the site needed; everything else is
presentation. They are implemented, with `openapi.yaml` and the generated
reference updated; `V2Platform` also carries per-system `broken`/`insecure`,
because that is the grain the flags actually have — a version broken on one
system is not a broken release, and the release-level rollup says so only
when every platform it has is broken.

Not built: presence spans from `variant_ranges` ("in nixpkgs-unstable
from 2025-03-02 to 2025-06-14"). It's the most distinctive thing the index
knows, but seeded ranges carry no presence information, so for everything
before the migration seed the honest display is "last changed at <commit>",
which is what `date` already says. Worth revisiting once the live timeline is
a few months long.

## Routes

#80 removed the unversioned aliases (`/search`, `/pkg`, `/pkg/{name}`,
`/resolve`, `/db/search`), which frees exactly the short, obvious names a
human-facing site wants. The API keeps `/v1/*`, `/v2/*`, `/status`,
`/status.json` and `/readyz`; the site takes the bare paths:

| Route | Page |
| --- | --- |
| `/` | Home: search box, index headline numbers, examples |
| `/search?q=go` | Search results |
| `/pkg/python` | Package: header, resolve panel, every release |
| `/pkg/python?v=3.11` | Same page with the resolve panel answering `v` |
| `/pkg/python/3.11.9` | One release: per-system detail, pinned refs |
| `/resolve?name=python&version=3.11` | 302 → `/pkg/python?v=3.11` |
| `/pkg?name=python` | 302 → `/pkg/python` |
| `/status` | Pre-existing; now on the shared shell |

`name` in the path takes anything `/v2/pkg` takes (case-insensitive name or
case-sensitive attribute path), so `/pkg/python311` works and the page shows
the canonical name. A search for a bare `name@version` (devbox syntax)
redirects to `/pkg/name?v=version`.

The deleted alias took *everything* after `/pkg/` as the name, because names
contain dots (`nodePackages.typescript`) and the Go handler used
`strings.Cut`. The site splits on `/` instead — first segment name, optional
second version — which is only safe because nothing in the index contains a
slash: a trigram search for `/` matches 0 of the 250k names and attribute
paths. Dots, `+`, `@` and unicode still need `decodeURIComponent` + NFD
normalization exactly as the old handler did. A version segment is matched
against that package's release list, so anything unexpected there is a plain
404 rather than a mis-parse.

Three things this buys beyond looking better than `/packages/…`:

- **`/search?q=go` keeps the meaning the old alias had**, just rendered for
  a human. Old links, bookmarks and blog posts land on a page that answers
  the same question instead of a 404.
- **The redirect rows** do the same for the query-parameter forms: someone
  following a three-year-old `/pkg?name=python` link arrives at the package
  page. It costs two lines of handler each.
- **`/pkg/python` is the URL people will type.** It is also what a package
  page should be called on a site whose entire subject is packages.

Rules that keep this from becoming a second API:

- **No content negotiation.** These paths are HTML, always, whatever
  `Accept` says. JSON is `/v1/*` and `/v2/*`, and every page links to its
  own JSON twin. A client that wants data never has to guess.
- **Stale JSON clients get HTML, not a 404.** Anything still calling
  `/search?q=` or `/pkg?name=` has been broken since #80 shipped; after
  this it fails at the JSON parse instead of the status code. Worth knowing
  when reading logs, not worth designing around — and the redirects mean a
  *human* following such a link is served properly.
- **`/db/search` stays gone.** It was an alias with no human meaning; a
  page there would be archaeology, not a feature.

Because `skipTrailingSlashRedirect` is on, `/pkg/python/` hits the same
route as `/pkg/python`; for pages (unlike the API's 400) it renders
normally — empty segments are dropped before lookup.

Crawler files live in the same group: `/robots.txt`, `/sitemap.xml`,
`/sitemaps/<n>.xml` and `/opensearch.xml`.

## Pages

### Home `/`

One search box, the numbers that make the site credible, and examples
that teach the query syntax by clicking:

- Search box, autofocused, placeholder `python, go@1.22, nodePackages.typescript`.
- Headline: `250,968 packages · 1,469,255 versions · 2,799 nixpkgs-unstable commits · updated 2 hours ago`, the numbers `/status.json` reports (fresh for the same five minutes, then served stale for up to a day while the edge refreshes).
- Example chips: `python` · `go@^1.22` · `nodejs@20` · `ripgrep` · `nodePackages.typescript`.
- One paragraph on what the index is (every commit of nixpkgs-unstable, incremental, never rebuilt) with links to the API reference, `/status`, and the repo.
- The `COMMON_PACKAGES` table from `/status` ("what `latest` resolves to today") is a good home-page section too — it is the fastest way to show what the site is for — but it stays on `/status` until the home page has real usage data.

### Search results `/search?q=`

A dense table, best match first, one row per package. Ranking is the API's
(exact name, exact attr path, name prefix, attr path prefix, trigram;
top-level attributes first) and is not re-sorted client-side.

| Column | Source | Notes |
| --- | --- | --- |
| Name | `name` | Links to `/pkg/<name>`. Matched substring highlighted. |
| Latest | `version` (new) | Tabular numerals |
| Attribute | `attribute_path` (new) | Mono; hidden when equal to name |
| Summary | `summary` | Single line, truncated |
| Systems | `systems` (new) | Four fixed cells `arm mac · arm linux · x86 mac · x86 linux`, filled or empty — a gap reads as a gap |
| Updated | `last_updated` | Relative, exact date in `title` |

Behaviour:

- The API caps results at 50; the page says so (`50 of many — refine the query`) rather than paginating, because the ranking beyond 50 is trigram noise anyway.
- Empty result: `No package named "zzz". Names are case-insensitive; attribute paths (nodePackages.foo) are case-sensitive.` — the same distinction the API docs make.
- `q=python@3.11` → 302 to `/pkg/python?v=3.11`. Anything after `@` is passed through as the version constraint untouched (`^1.22`, `>=3.10 <3.12`).
- A JSON link in the corner: `/v2/search?q=python`.

### Package `/pkg/<name>`

The main page. Top to bottom:

**Header.** Canonical name (large), `summary`, then a row of facts:
`license` · homepage link · `attribute_paths` as chips · "N releases".

**Resolve panel.** A one-line form, `name@[ version ]`, defaulting to
`latest`, that shows the `/v2/resolve` answer inline:

```
python@3.11  →  3.11.9   python311   rev 0a3468a4…   2026-09-18
                aarch64-darwin ✓  aarch64-linux ✓  x86_64-linux ✓  x86_64-darwin –
   devbox add python@3.11.9
   nix shell github:NixOS/nixpkgs/0a3468a4021f…#python311
```

Both commands are plain `<pre>` blocks with a copy button. This is
`/v2/resolve` made visible, including the single-hash rule: when systems
share a `rev` there is one line; when they don't (a system frozen at the
seed) each system gets its own `rev` and the panel says why. The form is a
GET (`?v=`), so a resolution has a URL and a JSON twin (`/v2/resolve?name=&version=`).

The version-matching rules (`3` ⇒ `>=3 <4`, `^`, `~`, prefix fallback) are
summarised in a `<details>` under the input — the same text as the API docs.

**Releases table.** Every `releases[]` entry, newest first, in the order
the API returns them (the version sort key, so prereleases sit under their
release). One row per version:

| Column | Source |
| --- | --- |
| Version | `version`; links to `/pkg/<name>/<version>`. `latest` badge on the row `latest` resolves to; `pre` / `broken` / `insecure` badges from the new flags |
| Systems | the four cells again, from `platforms[].system` |
| Attribute | `platforms[0].attribute_path`; `+1` when systems differ |
| Commit | `platforms[*].commit_hash` — one short hash when all systems agree, else `varies` and the per-system detail shows each. Links to `github.com/NixOS/nixpkgs/commit/<hash>` |
| Date | `last_updated` |
| Outputs | `outputs_summary` when non-empty (`out, debug (Linux only)`) |

Rows are `<details>`-free: 177 rows for python is fine as a table, and a
version's detail is its own page. A sticky `filter versions…` input at the
top of the table narrows rows by prefix client-side (the only optional JS on
the site; without it the table is simply long). Prerelease rows are shown
by default but muted, because `latest` skipping them is something people
come here to understand.

**Sidebar (wide layouts) / footer (narrow).** `homepage_url`, `license`,
`platforms_summary` of the latest release, links: `/v2/pkg?name=` JSON,
nixpkgs source search for the attribute path, `devbox add` snippet.

### Release `/pkg/<name>/<version>`

Permalink for one version — what you paste into a PR when you pin
something. Everything from one `releases[]` entry plus the resolve answer
for exactly that version:

- Header: `python 3.11.9` · summary · badges.
- Pinned references, one block per distinct `rev`:
  `github:NixOS/nixpkgs/<full rev>#python311` with the systems it covers, `nix shell …`, `devbox add python@3.11.9`.
- Per-system table: `system` (with `os`/`arch` in words), `attribute_path`, `commit_hash` (full, linked), `date`, `outputs` (name · path · default).
- Prev/next version links so the page can be walked like a changelog.
- JSON links: the `/v2/pkg` entry and `/v2/resolve?name=&version=`.

## Visual design

Continue `/status`'s language rather than invent a brand: warm neutral
surfaces, `system-ui` text, `ui-monospace` for everything that is an
identifier (attribute paths, hashes, store paths, commands), tabular
numerals in every column that holds numbers or dates, `color-scheme: light dark`
with the existing token set. Additions:

- `--danger` / `--danger-bg` for `broken` and `insecure`.
- A `--accent` (the current `--link` blue is fine) for the `latest` badge and the search focus ring.
- The four-system indicator: four small cells in a fixed order,
  `aarch64-darwin, aarch64-linux, x86_64-darwin, x86_64-linux`,
  `✓` in `--good` when present, `–` in `--muted` when not, always all four
  so columns line up and absence is visible. `i686-linux` is in the data
  but off the indicator (it's frozen at the seed and no devbox user asks
  for it); it still appears in per-system tables.

Density is developer-tool: tables, not cards; 15px base; no hero
imagery. Every page is readable with CSS off, and fully functional with JS
off — the copy buttons and version filter are progressive enhancements.

Every identifier is selectable in one triple-click: hashes are never split
across elements, commands are single-line `<pre>`s.

## Implementation

Same Next.js app, same pattern as `/status`: route handlers that return
HTML strings through `html()` from `lib/http.ts`, so pages get the same
`Cache-Control` / `ETag` / `HEAD` / `OPTIONS` / `405` handling as the JSON
they mirror, and the same one-hour edge cache. No React rendering on the
server and no client bundle; a page is a template function over a v2
response object.

```
app/(site)/route.ts                    /              →  lib/site/home.ts
app/(site)/search/route.ts             /search        →  lib/site/results.ts
app/(site)/pkg/[[...path]]/route.ts    /pkg/…         →  lib/site/pkg.ts, release.ts
app/(site)/resolve/route.ts            /resolve       →  302
app/(site)/robots.txt|sitemap.xml|sitemaps/[page]|opensearch.xml
app/status/route.ts                    /status        →  lib/site/statusPage.ts

lib/site/layout.ts    the shell: head, header, footer, the stylesheet, the two scripts
lib/site/format.ts    esc, relative, time, integer, the system indicator
lib/site/links.ts     every URL the site emits, so pages and redirects cannot drift
lib/site/sitemap.ts   package paging + XML
```

Each `lib/site/*.ts` takes a v2 object and returns a string. The renderers
in `lib/render.ts` gained declared return types (`V2Pkg`, `V2Release`, …)
for this: a page is a typed function of a response, not of a cast.

The pages live in a `(site)` route group, which `discoverRoutes` skips.
openapi.yaml is the contract for the machine API and a page is not part of
it, so `checkCoverage` does not ask for one. (`/status` stays documented —
it is an ops endpoint that happens to render HTML and mirrors
`/status.json` field for field.)

One catch-all serves the whole `/pkg` tree — no segments (redirect on
`?name=`, else `/`), one segment (package page), two (release page), more
than two is a 404. Its ancestor is the deleted alias,
`git show 80919b0e^:apps/web/app/pkg/\[\[...name\]\]/route.ts`.

Tests are in `lib/site/`: `pages.test.ts` renders each page from literal v2
objects (structure, states, escaping), `routes.test.ts` drives the handlers
against PGlite (path parsing, redirects, status codes).

Why not RSC pages: they would be nicer to write, but dynamic App Router
pages can't set `Cache-Control` from the page, the search page is
inherently dynamic (`?q=`), and the repo already has a working, tested,
zero-JS HTML pattern. Revisit if the site grows interactive.

Query cost: every page is a query the API already serves. The additive
fields come from columns already in the joins (`versions.prerelease`,
`variants.broken/insecure`, `meta.description`); `systems` on a search
result is one aggregate per row, served by `variants_identity_key`. The
package page needs two queries — the release list and the resolve answer —
and issues them together, since each is a round trip to a remote Postgres
(measured 0.51 s → 0.35 s against production). A release page needs only
the first: the version's per-system commits are already in `/v2/pkg`.

### What shipped

All of it, in one change:

- **v2 additive fields** — `renderV2Search` gained `version`, `attribute_path`, `systems`; `renderV2Pkg` gained `description`, `attribute_paths`, per-release `prerelease`/`broken`/`insecure` and per-platform `broken`/`insecure`. The v2 renderers also returned `unknown` before; they now return declared interfaces (`V2Pkg`, `V2Release`, …), which is what lets a page be a typed function of a response.
- **Pages** — `/`, `/search`, `/pkg/<name>`, `/pkg/<name>/<version>`, plus the `/pkg?name=` and `/resolve?name=` redirects. `/status` moved onto the shared shell.
- **Crawler files** — `/robots.txt`, `/sitemap.xml` + `/sitemaps/<n>.xml`, `/opensearch.xml`.
- **Enhancements** — copy buttons and the releases filter, both progressive (the pages work with JS off; the filter input is `hidden` until the script un-hides it).

### Crawling

Everything is crawlable: no `noindex` anywhere (the old one on `/status` is
gone), `robots.txt` allows all, and the sitemap index covers every package
page — six files of 50,000 URLs at today's 251k packages. Release pages are
not listed: they are linked from the package page a crawler already has, and
1.4M of them would be mostly churn.

The cost of being crawled is bounded by the edge cache (an hour per page,
a day for sitemaps) and by the WAF rate limit, which applies to pages just
as it does to the API. A sitemap page is one keyset query over `packages`
by primary key; measured against production, 0.5–0.8 s for 50,000 names.

## Decisions that were open

- **The `COMMON_PACKAGES` table is on the home page**, under the search box, as well as on `/status`. It is the fastest demonstration of what the site knows: a version, the attribute path serving it, and which systems have it.
- **Crawlers see everything.** No `noindex`, including on search result pages.
- **`x86_64-darwin` reads as dropped support**, which is what it is: nixpkgs 26.11 dropped it and the index is frozen there at the migration seed. The indicator shows the gap, and a legend under the home-page table says why rather than hiding it.

## Known trade-offs

- **The home page's numbers are exact, so it asks only for the ones it shows.** `status()` is seven exact `count(*)`s, and run together they compete for the same compute: ~1.2 s against production, most of it the `variants` count slowed by the others. The home page shows three counts, so it calls `homeStatus()`, which runs only those (packages, versions, commits) plus the newest commit and the `latest` table, in ~0.3 s. Approximate counts would be faster still and less honest.
- **A stale JSON client calling `/search?q=` or `/pkg?name=` now gets HTML or a redirect instead of a 404.** Anything doing that has been broken since #80 removed the aliases; it now fails at the parse rather than the status code. The redirects mean a *person* following such a link lands on the right page.
- **The releases table is the whole table.** python is 177 rows, and a few package sets are far longer. The filter input narrows it client-side; there is no pagination, because a version list is only useful whole.
- **The home page can be a day stale.** It is fresh for five minutes, like `/status.json`, but has a day of `stale-while-revalidate` rather than ten minutes, so a visitor after a quiet spell gets the previous render instantly instead of waiting for the counts. The first visitor after the quiet spell sees numbers (and an "updated … ago") as of that render; the edge refreshes it in the background for the next one. `/status` keeps the short window because it is where a stalled import should show.
