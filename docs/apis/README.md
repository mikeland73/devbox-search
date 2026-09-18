<!-- GENERATED FILE - do not edit. -->
<!-- Source: docs/apis/openapi.yaml; example responses are captured from the route handlers. -->
<!-- Regenerate with: pnpm --filter @devbox-search/web gen:api-docs -->

# devbox-search HTTP API

Package resolution and search over the nixpkgs index behind search.devbox.sh.

This document is generated from [`openapi.yaml`](./openapi.yaml) (the machine-readable contract - load it in
any OpenAPI viewer) plus responses captured by running the route handlers in `apps/web/app` against the
test fixture. Example bodies are pretty-printed here; the service sends compact JSON.

Resolves Devbox package references (`python@3.11`) to nixpkgs flake
references (commit hash + attribute path), and searches the index by
name. The v1 and v2 endpoints are byte-compatible with the original Go
service so shipped devbox CLIs keep working; `/v2/resolve` is the CLI's
critical path.

### Conventions shared by every endpoint

* **Methods.** Every endpoint is read-only. `GET` returns the response,
  `HEAD` returns its headers, `OPTIONS` returns `204` with
  `Allow: GET, HEAD, OPTIONS`, and `POST`/`PUT`/`PATCH`/`DELETE` return
  `405` with the same `Allow` header. (`/readyz` only defines `GET` and
  `HEAD`; the framework answers other methods with `405`.)
* **Input normalization.** Every query parameter is Unicode NFD-normalized
  and trimmed of leading/trailing whitespace before use; `system` is also
  lowercased. Empty (after trimming) required parameters yield `400`.
* **Name matching.** Wherever a `name` is accepted it matches either the
  canonical package name *case-insensitively* or a nixpkgs attribute path
  *case-sensitively* (`python`, `python311`, `nodePackages.typescript`).
* **Version matching** (`version` / `v` parameters):
  * `latest` — the highest non-prerelease version, preferring one that is
    not marked broken; if no non-prerelease version exists, the highest
    prerelease.
  * an exact version — `3.11.9`.
  * a partial version, treated as a range on dot boundaries —
    `3` ⇒ `>=3.0.0 <4.0.0`, `3.11` ⇒ `>=3.11.0 <3.12.0` (so `3.1` does
    not match `3.11`).
  * an npm-style range — `^3.11`, `~3.11.2`, `>=1.2 <2`, `>=1.2,<2`
    (comparators separated by whitespace or commas; a leading `v` is
    allowed on each version).
  * anything not expressible as semver (dates, `1.1.1w`, ...) falls back
    to prefix matching on a `.` or `-` boundary.

  Within the matching set the highest version is returned.
* **Successful JSON responses** carry `Content-Type: application/json`,
  `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`,
  and an `ETag` derived from the body.
* **Errors** are plain text in Go `http.Error` form —
  `<status> <reason>: <message>` followed by a newline — with
  `Content-Type: text/plain; charset=utf-8`,
  `X-Content-Type-Options: nosniff` and
  `Cache-Control: public, max-age=0, s-maxage=60`.
* **Timestamps.** v2 endpoints use RFC 3339 without fractional seconds
  (`2026-01-03T00:00:00Z`); v1 endpoints use Unix seconds as a JSON
  number.
* **`omitempty`.** In v1 (legacy) shapes, most fields were Go `omitempty`
  fields: a zero value (`""`, `false`, `0`, `[]`) is *absent* from the
  JSON, never `null`. Fields with this behaviour are marked **omitempty**
  below.

## Endpoints

| Method | Path | Summary | Handler |
| --- | --- | --- | --- |
| GET | [`/readyz`](#get-readyz) | Health check | `app/readyz/route.ts` |
| GET | [`/status`](#get-status) | Index status | `app/status/route.ts` |
| GET | [`/v2/resolve`](#get-v2resolve) | Resolve a package reference to a nixpkgs flake reference | `app/v2/resolve/route.ts` |
| GET | [`/v2/search`](#get-v2search) | Search packages by name | `app/v2/search/route.ts` |
| GET | [`/v2/pkg`](#get-v2pkg) | Every release of one package | `app/v2/pkg/route.ts` |
| GET | [`/v1/resolve`](#get-v1resolve) | Resolve a package reference (v1 shape) | `app/v1/resolve/route.ts` |
| GET | [`/resolve`](#get-resolve) | Alias of /v1/resolve | `app/resolve/route.ts` |
| GET | [`/v1/pkg`](#get-v1pkg) | Every version of one package (v1 shape) | `app/v1/pkg/route.ts` |
| GET | [`/pkg/{name}`](#get-pkgname) | Alias of /v1/pkg with the name in the path | `app/pkg/[[...name]]/route.ts` |
| GET | [`/pkg`](#get-pkg) | Alias of /v1/pkg | `app/pkg/[[...name]]/route.ts` |
| GET | [`/v1/search`](#get-v1search) | Search packages by name (v1 shape) | `app/v1/search/route.ts` |
| GET | [`/db/search`](#get-dbsearch) | Alias of /v1/search | `app/db/search/route.ts` |
| GET | [`/search`](#get-search) | Search packages (oldest shape) | `app/search/route.ts` |

## Method handling

Captured against `/v2/resolve`; every endpoint except `/readyz` behaves the same way.

<details>
<summary><b>OPTIONS</b> - <code>OPTIONS /v2/resolve</code> → <code>204</code></summary>

```http
OPTIONS /v2/resolve
```

```http
HTTP/1.1 204
Allow: GET, HEAD, OPTIONS
```

</details>

<details>
<summary><b>A write method</b> - <code>POST /v2/resolve</code> → <code>405</code></summary>

```http
POST /v2/resolve
```

```http
HTTP/1.1 405
Content-Type: text/plain; charset=utf-8
Allow: GET, HEAD, OPTIONS
X-Content-Type-Options: nosniff

405 Method Not Allowed
```

</details>

## v2

Current API, used by the devbox CLI.

### GET /v2/resolve

**Resolve a package reference to a nixpkgs flake reference**

The devbox CLI's critical path: `go@latest` →
`github:NixOS/nixpkgs/<rev>#go_1_22`. Returns the single best-matching
version (see *Version matching*) with one entry per system on which
it exists.

**Single hash across systems.** When the same version is present on
several systems, the newest nixpkgs commit that contains it on
*every* returned system is chosen and emitted as the `rev` for all
of them, so one `nix` fetch serves every platform. For a version
still in nixpkgs that commit is the newest one every returned
system has been indexed at, so `rev` and `last_updated` advance
with the index rather than with the package. Only systems indexed
since the migration take part; a system frozen at the migration
seed (x86_64-darwin) reports the commit of its own last change, as
does every system when no common commit is known.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | query | yes | Package name (case-insensitive) or nixpkgs attribute path (case-sensitive). |
| `version` | query | yes | `latest`, an exact version, a partial version, or an npm-style range (see *Version matching*). |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V2Resolve](#v2resolve) | The resolved version. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No version of the package matches. The message describes the normalized query, e.g. `no package found for: name = "python" && version = "9.99"`. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Latest version</b> - <code>GET /v2/resolve?name=python&amp;version=latest</code> → <code>200</code></summary>

```http
GET /v2/resolve?name=python&version=latest
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "kRcAu8D3ZB51GKkdlrXFeTOqyAL"

{
  "name": "python",
  "version": "3.12.4",
  "summary": "High-level dynamically-typed programming language",
  "systems": {
    "aarch64-darwin": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000003"
        },
        "attr_path": "python312"
      },
      "last_updated": "2026-01-03T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/8a7275a9a292b363bfe0d662f44ce21d-python-3.12.4-aarch64-darwin",
          "default": true
        }
      ]
    },
    "x86_64-linux": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000003"
        },
        "attr_path": "python312"
      },
      "last_updated": "2026-01-03T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/6f0235f7014606fad755bf2a3e326aee-python-3.12.4-x86_64-linux",
          "default": true
        }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>Partial version (dot-boundary range)</b> - <code>GET /v2/resolve?name=python&amp;version=3.11</code> → <code>200</code></summary>

```http
GET /v2/resolve?name=python&version=3.11
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "8ok7CBC4C4Ebewf7YyTDXe-HkmZ"

{
  "name": "python",
  "version": "3.11.9",
  "summary": "High-level dynamically-typed programming language",
  "systems": {
    "aarch64-darwin": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000002"
        },
        "attr_path": "python311"
      },
      "last_updated": "2026-01-02T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/41dde5f93f34661d63cba069c93cc222-python-3.11.9-aarch64-darwin",
          "default": true
        }
      ]
    },
    "x86_64-linux": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000002"
        },
        "attr_path": "python311"
      },
      "last_updated": "2026-01-02T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/79520992a3dc8137d26dacc98d7fcd66-python-3.11.9-x86_64-linux",
          "default": true
        }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>npm-style range</b> - <code>GET /v2/resolve?name=go&amp;version=^1.21</code> → <code>200</code></summary>

```http
GET /v2/resolve?name=go&version=^1.21
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "HVhCumc4_FarenxlRvAeACFedTW"

{
  "name": "go",
  "version": "1.22.5",
  "summary": "The Go Programming language",
  "systems": {
    "aarch64-darwin": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000003"
        },
        "attr_path": "go"
      },
      "last_updated": "2026-01-03T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/23577d103910a184ced09e1df34b5c3e-go-1.22.5-aarch64-darwin",
          "default": true
        }
      ]
    },
    "x86_64-linux": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000003"
        },
        "attr_path": "go"
      },
      "last_updated": "2026-01-03T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/921d868334b405912df8fa5595606dc3-go-1.22.5-x86_64-linux",
          "default": true
        }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>Attribute path instead of a name</b> - <code>GET /v2/resolve?name=go_1_21&amp;version=latest</code> → <code>200</code></summary>

```http
GET /v2/resolve?name=go_1_21&version=latest
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "9RUb7fC6AMr0Mnu4d5nXBLT5IGN"

{
  "name": "go",
  "version": "1.21.11",
  "summary": "The Go Programming language",
  "systems": {
    "aarch64-darwin": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000001"
        },
        "attr_path": "go_1_21"
      },
      "last_updated": "2026-01-01T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/b10d9d39384279fd896ecee39a66645d-go-1.21.11-aarch64-darwin",
          "default": true
        }
      ]
    },
    "x86_64-linux": {
      "flake_installable": {
        "ref": {
          "type": "github",
          "owner": "NixOS",
          "repo": "nixpkgs",
          "rev": "0000000000000000000000000000000000000001"
        },
        "attr_path": "go_1_21"
      },
      "last_updated": "2026-01-01T00:00:00Z",
      "outputs": [
        {
          "name": "out",
          "path": "/nix/store/10f6efde394559bb6fb7a3cec8f63a41-go-1.21.11-x86_64-linux",
          "default": true
        }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>No matching version</b> - <code>GET /v2/resolve?name=python&amp;version=9.99</code> → <code>404</code></summary>

```http
GET /v2/resolve?name=python&version=9.99
```

```http
HTTP/1.1 404
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

404 Not Found: no package found for: name = "python" && version = "9.99"
```

</details>

<details>
<summary><b>Missing parameter</b> - <code>GET /v2/resolve?name=python</code> → <code>400</code></summary>

```http
GET /v2/resolve?name=python
```

```http
HTTP/1.1 400
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

400 Bad Request: empty version (set a ?version=<value> query parameter)
```

</details>

### GET /v2/search

**Search packages by name**

Text search over package names and attribute paths. Ranking: exact
name match, then exact attribute-path match, then name prefix, then
attribute-path prefix, then trigram similarity; top-level nixpkgs
attributes outrank nested ones (`python3` above
`emacsPackages.python`). Ties are broken by name.

Returns the latest non-prerelease release of each matching package,
at most 50 packages. An empty result set is a `200` with
`total_results: 0`, not a `404`.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `q` | query | yes | Search phrase, matched against package names and attribute paths. |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V2Search](#v2search) | Matching packages, best match first. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Search</b> - <code>GET /v2/search?q=go</code> → <code>200</code></summary>

```http
GET /v2/search?q=go
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "9lkUf2mfmc96w2pxl-JayMw5B28"

{
  "query": "go",
  "total_results": 2,
  "results": [
    {
      "name": "go",
      "summary": "The Go Programming language",
      "last_updated": "2026-01-03T00:00:00Z"
    },
    {
      "name": "go-task",
      "summary": "Task runner / simpler Make alternative written in Go",
      "last_updated": "2026-01-02T00:00:00Z"
    }
  ]
}
```

</details>

<details>
<summary><b>No matches</b> - <code>GET /v2/search?q=zzzzzz</code> → <code>200</code></summary>

```http
GET /v2/search?q=zzzzzz
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "zThsOiPOD-yJn_x34vhofWOkGJB"

{
  "query": "zzzzzz",
  "total_results": 0,
  "results": []
}
```

</details>

### GET /v2/pkg

**Every release of one package**

All versions of a package, newest first, with per-platform detail
and human-readable platform/output summaries for display.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | query | yes | Package name (case-insensitive) or nixpkgs attribute path (case-sensitive). |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V2Pkg](#v2pkg) | The package and its releases. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No package by that name. The body is the bare `404 Not Found:` line (no query description). |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Package detail</b> - <code>GET /v2/pkg?name=python</code> → <code>200</code></summary>

```http
GET /v2/pkg?name=python
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "XkwiWyiN4Sd1diHPDbJK29F3VVQ"

{
  "name": "python",
  "summary": "High-level dynamically-typed programming language",
  "homepage_url": "https://www.python.org",
  "license": "PSF-2.0",
  "releases": [
    {
      "version": "3.12.4",
      "last_updated": "2026-01-03T00:00:00Z",
      "platforms": [
        {
          "arch": "arm64",
          "os": "macOS",
          "system": "aarch64-darwin",
          "attribute_path": "python312",
          "commit_hash": "0000000000000000000000000000000000000003",
          "date": "2026-01-03T00:00:00Z",
          "outputs": [
            {
              "name": "out",
              "path": "/nix/store/8a7275a9a292b363bfe0d662f44ce21d-python-3.12.4-aarch64-darwin",
              "default": true
            }
          ]
        },
        {
          "arch": "x86-64",
          "os": "Linux",
          "system": "x86_64-linux",
          "attribute_path": "python312",
          "commit_hash": "0000000000000000000000000000000000000003",
          "date": "2026-01-03T00:00:00Z",
          "outputs": [
            {
              "name": "out",
              "path": "/nix/store/6f0235f7014606fad755bf2a3e326aee-python-3.12.4-x86_64-linux",
              "default": true
            }
          ]
        }
      ],
      "platforms_summary": "Linux and macOS (Apple Silicon only)",
      "outputs_summary": ""
    },
    {
      "version": "3.11.9",
      "last_updated": "2026-01-02T00:00:00Z",
      "platforms": [
        {
          "arch": "arm64",
          "os": "macOS",
          "system": "aarch64-darwin",
          "attribute_path": "python311",
          "commit_hash": "0000000000000000000000000000000000000002",
          "date": "2026-01-02T00:00:00Z",
          "outputs": [
            {
              "name": "out",
              "path": "/nix/store/41dde5f93f34661d63cba069c93cc222-python-3.11.9-aarch64-darwin",
              "default": true
            }
          ]
        },
        {
          "arch": "x86-64",
          "os": "Linux",
          "system": "x86_64-linux",
          "attribute_path": "python311",
          "commit_hash": "0000000000000000000000000000000000000002",
          "date": "2026-01-02T00:00:00Z",
          "outputs": [
            {
              "name": "out",
              "path": "/nix/store/79520992a3dc8137d26dacc98d7fcd66-python-3.11.9-x86_64-linux",
              "default": true
            }
          ]
        }
      ],
      "platforms_summary": "Linux and macOS (Apple Silicon only)",
      "outputs_summary": ""
    }
  ]
}
```

</details>

<details>
<summary><b>Unknown package</b> - <code>GET /v2/pkg?name=doesnotexist</code> → <code>404</code></summary>

```http
GET /v2/pkg?name=doesnotexist
```

```http
HTTP/1.1 404
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

404 Not Found:
```

</details>

## v1

Legacy API kept for older devbox CLIs. `/resolve`, `/pkg` and `/db/search` are aliases.

### GET /v1/resolve

**Resolve a package reference (v1 shape)**

Same matching rules as `/v2/resolve`, plus an optional `system`
filter, returning the single best-matching version in the legacy
shape. Each system reports its own commit (no single-hash
selection).

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | query | yes | Package name (case-insensitive) or nixpkgs attribute path (case-sensitive). |
| `version` | query | yes | `latest`, an exact version, a partial version, or an npm-style range (see *Version matching*). |
| `system` | query | no | Restrict results to one Nix system (lowercased before matching). |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V1PackageVersion](#v1packageversion) | The resolved version. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No version matches. The message describes the normalized query, including `system` when given. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Latest version</b> - <code>GET /v1/resolve?name=python&amp;version=latest</code> → <code>200</code></summary>

```http
GET /v1/resolve?name=python&version=latest
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "d8w_I0mDCnzvBXNaU1nLTEf9tH1"

{
  "commit_hash": "0000000000000000000000000000000000000003",
  "last_updated": 1767398400,
  "version": "3.12.4",
  "platforms": [
    "aarch64-darwin",
    "aarch64-linux",
    "x86_64-darwin",
    "x86_64-linux"
  ],
  "summary": "High-level dynamically-typed programming language",
  "homepage": "https://www.python.org",
  "license": "PSF-2.0",
  "name": "python",
  "systems": {
    "aarch64-darwin": {
      "commit_hash": "0000000000000000000000000000000000000003",
      "last_updated": 1767398400,
      "version": "3.12.4",
      "platforms": [
        "aarch64-darwin",
        "aarch64-linux",
        "x86_64-darwin",
        "x86_64-linux"
      ],
      "summary": "High-level dynamically-typed programming language",
      "homepage": "https://www.python.org",
      "license": "PSF-2.0",
      "system": "aarch64-darwin",
      "store_hash": "8a7275a9a292b363bfe0d662f44ce21d",
      "store_name": "python",
      "store_version": "3.12.4",
      "meta_name": "python-3.12.4",
      "attr_paths": [
        "python312"
      ],
      "programs": [
        "python3"
      ]
    },
    "x86_64-linux": {
      "commit_hash": "0000000000000000000000000000000000000003",
      "last_updated": 1767398400,
      "version": "3.12.4",
      "platforms": [
        "aarch64-darwin",
        "aarch64-linux",
        "x86_64-darwin",
        "x86_64-linux"
      ],
      "summary": "High-level dynamically-typed programming language",
      "homepage": "https://www.python.org",
      "license": "PSF-2.0",
      "system": "x86_64-linux",
      "store_hash": "6f0235f7014606fad755bf2a3e326aee",
      "store_name": "python",
      "store_version": "3.12.4",
      "meta_name": "python-3.12.4",
      "attr_paths": [
        "python312"
      ],
      "programs": [
        "python3"
      ]
    }
  }
}
```

</details>

<details>
<summary><b>Restricted to one system</b> - <code>GET /v1/resolve?name=python&amp;version=3.11&amp;system=aarch64-darwin</code> → <code>200</code></summary>

```http
GET /v1/resolve?name=python&version=3.11&system=aarch64-darwin
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "noaMmaCtq4lVf2tO7oyAQFM7Xyw"

{
  "commit_hash": "0000000000000000000000000000000000000002",
  "last_updated": 1767312000,
  "version": "3.11.9",
  "platforms": [
    "aarch64-darwin",
    "aarch64-linux",
    "x86_64-darwin",
    "x86_64-linux"
  ],
  "summary": "High-level dynamically-typed programming language",
  "homepage": "https://www.python.org",
  "license": "PSF-2.0",
  "name": "python",
  "systems": {
    "aarch64-darwin": {
      "commit_hash": "0000000000000000000000000000000000000002",
      "last_updated": 1767312000,
      "version": "3.11.9",
      "platforms": [
        "aarch64-darwin",
        "aarch64-linux",
        "x86_64-darwin",
        "x86_64-linux"
      ],
      "summary": "High-level dynamically-typed programming language",
      "homepage": "https://www.python.org",
      "license": "PSF-2.0",
      "system": "aarch64-darwin",
      "store_hash": "41dde5f93f34661d63cba069c93cc222",
      "store_name": "python",
      "store_version": "3.11.9",
      "meta_name": "python-3.11.9",
      "attr_paths": [
        "python311"
      ],
      "programs": [
        "python3"
      ]
    }
  }
}
```

</details>

<details>
<summary><b>No matching version</b> - <code>GET /v1/resolve?name=python&amp;version=9.99&amp;system=x86_64-linux</code> → <code>404</code></summary>

```http
GET /v1/resolve?name=python&version=9.99&system=x86_64-linux
```

```http
HTTP/1.1 404
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

404 Not Found: no package found for: name = "python" && version = "9.99" && system = "x86_64-linux"
```

</details>

### GET /resolve

**Alias of /v1/resolve**

Identical to `/v1/resolve`.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | query | yes | Package name (case-insensitive) or nixpkgs attribute path (case-sensitive). |
| `version` | query | yes | `latest`, an exact version, a partial version, or an npm-style range (see *Version matching*). |
| `system` | query | no | Restrict results to one Nix system (lowercased before matching). |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V1PackageVersion](#v1packageversion) | The resolved version. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No version matches. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Partial version</b> - <code>GET /resolve?name=python&amp;version=3.11</code> → <code>200</code></summary>

```http
GET /resolve?name=python&version=3.11
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "Au1LjO6tE6ORAumJEDrQnu-Dv0F"

{
  "commit_hash": "0000000000000000000000000000000000000002",
  "last_updated": 1767312000,
  "version": "3.11.9",
  "platforms": [
    "aarch64-darwin",
    "aarch64-linux",
    "x86_64-darwin",
    "x86_64-linux"
  ],
  "summary": "High-level dynamically-typed programming language",
  "homepage": "https://www.python.org",
  "license": "PSF-2.0",
  "name": "python",
  "systems": {
    "aarch64-darwin": {
      "commit_hash": "0000000000000000000000000000000000000002",
      "last_updated": 1767312000,
      "version": "3.11.9",
      "platforms": [
        "aarch64-darwin",
        "aarch64-linux",
        "x86_64-darwin",
        "x86_64-linux"
      ],
      "summary": "High-level dynamically-typed programming language",
      "homepage": "https://www.python.org",
      "license": "PSF-2.0",
      "system": "aarch64-darwin",
      "store_hash": "41dde5f93f34661d63cba069c93cc222",
      "store_name": "python",
      "store_version": "3.11.9",
      "meta_name": "python-3.11.9",
      "attr_paths": [
        "python311"
      ],
      "programs": [
        "python3"
      ]
    },
    "x86_64-linux": {
      "commit_hash": "0000000000000000000000000000000000000002",
      "last_updated": 1767312000,
      "version": "3.11.9",
      "platforms": [
        "aarch64-darwin",
        "aarch64-linux",
        "x86_64-darwin",
        "x86_64-linux"
      ],
      "summary": "High-level dynamically-typed programming language",
      "homepage": "https://www.python.org",
      "license": "PSF-2.0",
      "system": "x86_64-linux",
      "store_hash": "79520992a3dc8137d26dacc98d7fcd66",
      "store_name": "python",
      "store_version": "3.11.9",
      "meta_name": "python-3.11.9",
      "attr_paths": [
        "python311"
      ],
      "programs": [
        "python3"
      ]
    }
  }
}
```

</details>

### GET /v1/pkg

**Every version of one package (v1 shape)**

All versions of a package, newest first, as a list of legacy
version objects (at most 1000 underlying rows).

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | query | yes | Package name (case-insensitive) or nixpkgs attribute path (case-sensitive). |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | array of [V1PackageVersion](#v1packageversion) | The package's versions. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No package by that name (`no package found for: name = "..."`). |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Package versions</b> - <code>GET /v1/pkg?name=go</code> → <code>200</code></summary>

```http
GET /v1/pkg?name=go
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "_RmZNBhsj1SOghqgjMpwOMRzRkm"

[
  {
    "commit_hash": "0000000000000000000000000000000000000003",
    "last_updated": 1767398400,
    "version": "1.22.5",
    "platforms": [
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux"
    ],
    "summary": "The Go Programming language",
    "homepage": "https://go.dev/",
    "license": "BSD-3-Clause",
    "name": "go",
    "systems": {
      "aarch64-darwin": {
        "commit_hash": "0000000000000000000000000000000000000003",
        "last_updated": 1767398400,
        "version": "1.22.5",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "aarch64-darwin",
        "store_hash": "23577d103910a184ced09e1df34b5c3e",
        "store_name": "go",
        "store_version": "1.22.5",
        "meta_name": "go-1.22.5",
        "attr_paths": [
          "go"
        ],
        "programs": [
          "go"
        ]
      },
      "x86_64-linux": {
        "commit_hash": "0000000000000000000000000000000000000003",
        "last_updated": 1767398400,
        "version": "1.22.5",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "x86_64-linux",
        "store_hash": "921d868334b405912df8fa5595606dc3",
        "store_name": "go",
        "store_version": "1.22.5",
        "meta_name": "go-1.22.5",
        "attr_paths": [
          "go"
        ],
        "programs": [
          "go"
        ]
      }
    }
  },
  {
    "commit_hash": "0000000000000000000000000000000000000001",
    "last_updated": 1767225600,
    "version": "1.21.11",
    "platforms": [
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux"
    ],
    "summary": "The Go Programming language",
    "homepage": "https://go.dev/",
    "license": "BSD-3-Clause",
    "name": "go",
    "systems": {
      "aarch64-darwin": {
        "commit_hash": "0000000000000000000000000000000000000001",
        "last_updated": 1767225600,
        "version": "1.21.11",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "aarch64-darwin",
        "store_hash": "b10d9d39384279fd896ecee39a66645d",
        "store_name": "go",
        "store_version": "1.21.11",
        "meta_name": "go-1.21.11",
        "attr_paths": [
          "go_1_21"
        ],
        "programs": [
          "go"
        ]
      },
      "x86_64-linux": {
        "commit_hash": "0000000000000000000000000000000000000001",
        "last_updated": 1767225600,
        "version": "1.21.11",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "x86_64-linux",
        "store_hash": "10f6efde394559bb6fb7a3cec8f63a41",
        "store_name": "go",
        "store_version": "1.21.11",
        "meta_name": "go-1.21.11",
        "attr_paths": [
          "go_1_21"
        ],
        "programs": [
          "go"
        ]
      }
    }
  }
]
```

</details>

<details>
<summary><b>Unknown package</b> - <code>GET /v1/pkg?name=doesnotexist</code> → <code>404</code></summary>

```http
GET /v1/pkg?name=doesnotexist
```

```http
HTTP/1.1 404
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

404 Not Found: no package found for: name = "doesnotexist"
```

</details>

### GET /pkg/{name}

**Alias of /v1/pkg with the name in the path**

Identical to `/v1/pkg`, taking the package name from the path.
**Everything** after `/pkg/` is the name — including dots and
further slashes (`/pkg/nodePackages.typescript`) — after URL
decoding.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | path | yes | The package name or attribute path; the entire remainder of the URL path. |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | array of [V1PackageVersion](#v1packageversion) | The package's versions. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No package by that name. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Dotted attribute path in the URL</b> - <code>GET /pkg/nodePackages.typescript</code> → <code>200</code></summary>

```http
GET /pkg/nodePackages.typescript
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "aHetrh-UjwACwMzGS-X58iNA9KZ"

[
  {
    "commit_hash": "0000000000000000000000000000000000000003",
    "last_updated": 1767398400,
    "version": "5.5.4",
    "platforms": [
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux"
    ],
    "summary": "A superset of JavaScript that compiles to clean JavaScript output",
    "homepage": "https://www.typescriptlang.org/",
    "license": "Apache-2.0",
    "name": "nodePackages.typescript",
    "systems": {
      "aarch64-darwin": {
        "commit_hash": "0000000000000000000000000000000000000003",
        "last_updated": 1767398400,
        "version": "5.5.4",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "A superset of JavaScript that compiles to clean JavaScript output",
        "homepage": "https://www.typescriptlang.org/",
        "license": "Apache-2.0",
        "system": "aarch64-darwin",
        "store_hash": "8821bfcecf00657472063ad8213833a2",
        "store_name": "nodePackages.typescript",
        "store_version": "5.5.4",
        "meta_name": "nodePackages.typescript-5.5.4",
        "attr_paths": [
          "nodePackages.typescript"
        ],
        "programs": [
          "tsc"
        ]
      },
      "x86_64-linux": {
        "commit_hash": "0000000000000000000000000000000000000003",
        "last_updated": 1767398400,
        "version": "5.5.4",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "A superset of JavaScript that compiles to clean JavaScript output",
        "homepage": "https://www.typescriptlang.org/",
        "license": "Apache-2.0",
        "system": "x86_64-linux",
        "store_hash": "83f11c3bae78dd691b9b45a23c61f500",
        "store_name": "nodePackages.typescript",
        "store_version": "5.5.4",
        "meta_name": "nodePackages.typescript-5.5.4",
        "attr_paths": [
          "nodePackages.typescript"
        ],
        "programs": [
          "tsc"
        ]
      }
    }
  }
]
```

</details>

### GET /pkg

**Alias of /v1/pkg**

Identical to `/v1/pkg`; used when no name is given in the path.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `name` | query | yes | Package name (case-insensitive) or nixpkgs attribute path (case-sensitive). |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | array of [V1PackageVersion](#v1packageversion) | The package's versions. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 404 | `text/plain; charset=utf-8` | string | No package by that name. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Query-string form</b> - <code>GET /pkg?name=go</code> → <code>200</code></summary>

```http
GET /pkg?name=go
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "_RmZNBhsj1SOghqgjMpwOMRzRkm"

[
  {
    "commit_hash": "0000000000000000000000000000000000000003",
    "last_updated": 1767398400,
    "version": "1.22.5",
    "platforms": [
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux"
    ],
    "summary": "The Go Programming language",
    "homepage": "https://go.dev/",
    "license": "BSD-3-Clause",
    "name": "go",
    "systems": {
      "aarch64-darwin": {
        "commit_hash": "0000000000000000000000000000000000000003",
        "last_updated": 1767398400,
        "version": "1.22.5",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "aarch64-darwin",
        "store_hash": "23577d103910a184ced09e1df34b5c3e",
        "store_name": "go",
        "store_version": "1.22.5",
        "meta_name": "go-1.22.5",
        "attr_paths": [
          "go"
        ],
        "programs": [
          "go"
        ]
      },
      "x86_64-linux": {
        "commit_hash": "0000000000000000000000000000000000000003",
        "last_updated": 1767398400,
        "version": "1.22.5",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "x86_64-linux",
        "store_hash": "921d868334b405912df8fa5595606dc3",
        "store_name": "go",
        "store_version": "1.22.5",
        "meta_name": "go-1.22.5",
        "attr_paths": [
          "go"
        ],
        "programs": [
          "go"
        ]
      }
    }
  },
  {
    "commit_hash": "0000000000000000000000000000000000000001",
    "last_updated": 1767225600,
    "version": "1.21.11",
    "platforms": [
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux"
    ],
    "summary": "The Go Programming language",
    "homepage": "https://go.dev/",
    "license": "BSD-3-Clause",
    "name": "go",
    "systems": {
      "aarch64-darwin": {
        "commit_hash": "0000000000000000000000000000000000000001",
        "last_updated": 1767225600,
        "version": "1.21.11",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "aarch64-darwin",
        "store_hash": "b10d9d39384279fd896ecee39a66645d",
        "store_name": "go",
        "store_version": "1.21.11",
        "meta_name": "go-1.21.11",
        "attr_paths": [
          "go_1_21"
        ],
        "programs": [
          "go"
        ]
      },
      "x86_64-linux": {
        "commit_hash": "0000000000000000000000000000000000000001",
        "last_updated": 1767225600,
        "version": "1.21.11",
        "platforms": [
          "aarch64-darwin",
          "aarch64-linux",
          "x86_64-darwin",
          "x86_64-linux"
        ],
        "summary": "The Go Programming language",
        "homepage": "https://go.dev/",
        "license": "BSD-3-Clause",
        "system": "x86_64-linux",
        "store_hash": "10f6efde394559bb6fb7a3cec8f63a41",
        "store_name": "go",
        "store_version": "1.21.11",
        "meta_name": "go-1.21.11",
        "attr_paths": [
          "go_1_21"
        ],
        "programs": [
          "go"
        ]
      }
    }
  }
]
```

</details>

<details>
<summary><b>Missing name</b> - <code>GET /pkg</code> → <code>400</code></summary>

```http
GET /pkg
```

```http
HTTP/1.1 400
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

400 Bad Request: empty name (set a ?name=<value> query parameter)
```

</details>

### GET /v1/search

**Search packages by name (v1 shape)**

Same ranking as `/v2/search`, but returns **every** version of each
matching package (at most 50 packages / 1000 rows) in the legacy
shape. An empty result set is `{"num_results":0}`.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `q` | query | yes | Search phrase, matched against package names and attribute paths. |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V1Search](#v1search) | Matching packages, best match first. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Search</b> - <code>GET /v1/search?q=python</code> → <code>200</code></summary>

```http
GET /v1/search?q=python
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "yQ48UPFcEpXbXvd-wwrNbE7vcYP"

{
  "num_results": 1,
  "packages": [
    {
      "name": "python",
      "num_versions": 2,
      "versions": [
        {
          "commit_hash": "0000000000000000000000000000000000000003",
          "last_updated": 1767398400,
          "version": "3.12.4",
          "platforms": [
            "aarch64-darwin",
            "aarch64-linux",
            "x86_64-darwin",
            "x86_64-linux"
          ],
          "summary": "High-level dynamically-typed programming language",
          "homepage": "https://www.python.org",
          "license": "PSF-2.0",
          "name": "python",
          "systems": {
            "aarch64-darwin": {
              "commit_hash": "0000000000000000000000000000000000000003",
              "last_updated": 1767398400,
              "version": "3.12.4",
              "platforms": [
                "aarch64-darwin",
                "aarch64-linux",
                "x86_64-darwin",
                "x86_64-linux"
              ],
              "summary": "High-level dynamically-typed programming language",
              "homepage": "https://www.python.org",
              "license": "PSF-2.0",
              "system": "aarch64-darwin",
              "store_hash": "8a7275a9a292b363bfe0d662f44ce21d",
              "store_name": "python",
              "store_version": "3.12.4",
              "meta_name": "python-3.12.4",
              "attr_paths": [
                "python312"
              ],
              "programs": [
                "python3"
              ]
            }
          }
        },
        {
          "commit_hash": "0000000000000000000000000000000000000002",
          "last_updated": 1767312000,
          "version": "3.11.9",
          "platforms": [
            "aarch64-darwin",
            "aarch64-linux",
            "x86_64-darwin",
            "x86_64-linux"
          ],
          "summary": "High-level dynamically-typed programming language",
          "homepage": "https://www.python.org",
          "license": "PSF-2.0",
          "name": "python",
          "systems": {
            "aarch64-darwin": {
              "commit_hash": "0000000000000000000000000000000000000002",
              "last_updated": 1767312000,
              "version": "3.11.9",
              "platforms": [
                "aarch64-darwin",
                "aarch64-linux",
                "x86_64-darwin",
                "x86_64-linux"
              ],
              "summary": "High-level dynamically-typed programming language",
              "homepage": "https://www.python.org",
              "license": "PSF-2.0",
              "system": "aarch64-darwin",
              "store_hash": "41dde5f93f34661d63cba069c93cc222",
              "store_name": "python",
              "store_version": "3.11.9",
              "meta_name": "python-3.11.9",
              "attr_paths": [
                "python311"
              ],
              "programs": [
                "python3"
              ]
            }
          }
        }
      ]
    }
  ]
}
```

</details>

<details>
<summary><b>No matches</b> - <code>GET /v1/search?q=zzzzzz</code> → <code>200</code></summary>

```http
GET /v1/search?q=zzzzzz
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "TWxpVxWzEJnMY4Kugto8u1nKDEI"

{
  "num_results": 0
}
```

</details>

### GET /db/search

**Alias of /v1/search**

Identical to `/v1/search`.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `q` | query | yes | Search phrase, matched against package names and attribute paths. |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [V1Search](#v1search) | Matching packages, best match first. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Search</b> - <code>GET /db/search?q=go</code> → <code>200</code></summary>

```http
GET /db/search?q=go
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "n0QiVLnVFIUzW95I-Vlnxi8UkiX"

{
  "num_results": 2,
  "packages": [
    {
      "name": "go",
      "num_versions": 2,
      "versions": [
        {
          "commit_hash": "0000000000000000000000000000000000000003",
          "last_updated": 1767398400,
          "version": "1.22.5",
          "platforms": [
            "aarch64-darwin",
            "aarch64-linux",
            "x86_64-darwin",
            "x86_64-linux"
          ],
          "summary": "The Go Programming language",
          "homepage": "https://go.dev/",
          "license": "BSD-3-Clause",
          "name": "go",
          "systems": {
            "aarch64-darwin": {
              "commit_hash": "0000000000000000000000000000000000000003",
              "last_updated": 1767398400,
              "version": "1.22.5",
              "platforms": [
                "aarch64-darwin",
                "aarch64-linux",
                "x86_64-darwin",
                "x86_64-linux"
              ],
              "summary": "The Go Programming language",
              "homepage": "https://go.dev/",
              "license": "BSD-3-Clause",
              "system": "aarch64-darwin",
              "store_hash": "23577d103910a184ced09e1df34b5c3e",
              "store_name": "go",
              "store_version": "1.22.5",
              "meta_name": "go-1.22.5",
              "attr_paths": [
                "go"
              ],
              "programs": [
                "go"
              ]
            }
          }
        },
        {
          "commit_hash": "0000000000000000000000000000000000000001",
          "last_updated": 1767225600,
          "version": "1.21.11",
          "platforms": [
            "aarch64-darwin",
            "aarch64-linux",
            "x86_64-darwin",
            "x86_64-linux"
          ],
          "summary": "The Go Programming language",
          "homepage": "https://go.dev/",
          "license": "BSD-3-Clause",
          "name": "go",
          "systems": {
            "aarch64-darwin": {
              "commit_hash": "0000000000000000000000000000000000000001",
              "last_updated": 1767225600,
              "version": "1.21.11",
              "platforms": [
                "aarch64-darwin",
                "aarch64-linux",
                "x86_64-darwin",
                "x86_64-linux"
              ],
              "summary": "The Go Programming language",
              "homepage": "https://go.dev/",
              "license": "BSD-3-Clause",
              "system": "aarch64-darwin",
              "store_hash": "b10d9d39384279fd896ecee39a66645d",
              "store_name": "go",
              "store_version": "1.21.11",
              "meta_name": "go-1.21.11",
              "attr_paths": [
                "go_1_21"
              ],
              "programs": [
                "go"
              ]
            }
          }
        }
      ]
    },
    {
      "name": "go-task",
      "num_versions": 1,
      "versions": [
        {
          "commit_hash": "0000000000000000000000000000000000000002",
          "last_updated": 1767312000,
          "version": "3.38.0",
          "platforms": [
            "aarch64-darwin",
            "aarch64-linux",
            "x86_64-darwin",
            "x86_64-linux"
          ],
          "summary": "Task runner / simpler Make alternative written in Go",
          "homepage": "https://taskfile.dev/",
          "license": "MIT",
          "name": "go-task",
          "systems": {
            "aarch64-darwin": {
              "commit_hash": "0000000000000000000000000000000000000002",
              "last_updated": 1767312000,
              "version": "3.38.0",
              "platforms": [
                "aarch64-darwin",
                "aarch64-linux",
                "x86_64-darwin",
                "x86_64-linux"
              ],
              "summary": "Task runner / simpler Make alternative written in Go",
              "homepage": "https://taskfile.dev/",
              "license": "MIT",
              "system": "aarch64-darwin",
              "store_hash": "236e98dffd9369310224fdd8b2c354fc",
              "store_name": "go-task",
              "store_version": "3.38.0",
              "meta_name": "go-task-3.38.0",
              "attr_paths": [
                "go-task"
              ],
              "programs": [
                "task"
              ]
            }
          }
        }
      ]
    }
  ]
}
```

</details>

### GET /search

**Search packages (oldest shape)**

The original search endpoint. Without `v`, `q` is a search phrase
(same ranking as `/v2/search`, every version returned). With `v`,
`q` is treated as an exact **name** and the single version matching
`v` is returned (same rules as `/v2/resolve`).

Within each result, entries are collapsed to one per
`pname`+`version` (consecutive duplicates across systems are
dropped). An empty result set is `200` with `total_results: 0`.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Parameters

| Name | In | Required | Description |
| --- | --- | --- | --- |
| `q` | query | yes | Search phrase, matched against package names and attribute paths. |
| `v` | query | no | A version (see *Version matching*). When present, `q` is matched as an exact name rather than a search phrase. |

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Search](#search) | Matching packages. |
| 400 | `text/plain; charset=utf-8` | string | A required parameter is missing or empty, e.g. `400 Bad Request: empty name (set a ?name=<value> query parameter)`. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

#### Examples

<details>
<summary><b>Phrase search</b> - <code>GET /search?q=python</code> → <code>200</code></summary>

```http
GET /search?q=python
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "5M7-MIElxzJwBV5mPOZeUsYAUMb"

{
  "metadata": {
    "total_results": 1
  },
  "results": [
    {
      "name": "python",
      "packages": [
        {
          "attribute_path": "python312",
          "pname": "python-3.12.4",
          "version": "3.12.4",
          "date": "2026-01-03T00:00:00Z",
          "nixpkg_commit": "0000000000000000000000000000000000000003"
        },
        {
          "attribute_path": "python311",
          "pname": "python-3.11.9",
          "version": "3.11.9",
          "date": "2026-01-02T00:00:00Z",
          "nixpkg_commit": "0000000000000000000000000000000000000002"
        }
      ]
    }
  ]
}
```

</details>

<details>
<summary><b>Name + version lookup</b> - <code>GET /search?q=python&amp;v=3.11</code> → <code>200</code></summary>

```http
GET /search?q=python&v=3.11
```

```http
HTTP/1.1 200
Content-Type: application/json
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
ETag: "JjlJRs89i5OV2Jrey_EWCDMtJtx"

{
  "metadata": {
    "total_results": 1
  },
  "results": [
    {
      "name": "python",
      "packages": [
        {
          "attribute_path": "python311",
          "pname": "python-3.11.9",
          "version": "3.11.9",
          "date": "2026-01-02T00:00:00Z",
          "nixpkg_commit": "0000000000000000000000000000000000000002"
        }
      ]
    }
  ]
}
```

</details>

<details>
<summary><b>Missing query</b> - <code>GET /search</code> → <code>400</code></summary>

```http
GET /search
```

```http
HTTP/1.1 400
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=0, s-maxage=60
X-Content-Type-Options: nosniff

400 Bad Request: empty search query (set a ?q=<term> query parameter)
```

</details>

## ops

Health check and index status. Not part of the Go service's API.

### GET /readyz

**Health check**

Returns the literal `ok` plus a newline. Not cached
(`Cache-Control: no-store`).

Methods: `GET`, `HEAD`

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `text/plain;charset=utf-8` | `"ok\n"` | The service is up. |

#### Examples

<details>
<summary><b>Health check</b> - <code>GET /readyz</code> → <code>200</code></summary>

```http
GET /readyz
```

```http
HTTP/1.1 200
Content-Type: text/plain;charset=utf-8
Cache-Control: no-store

ok
```

</details>

### GET /status

**Index status**

Index-wide statistics: exact row counts, the span of the commit
timeline, and when each Nix system was last imported — enough to tell
at a glance whether the daily import is keeping up, and where a
system frozen at an older commit shows up. Cached for five minutes
(`Cache-Control: public, s-maxage=300, stale-while-revalidate=600`).

Unlike the v1/v2 endpoints this shape is not Go-derived: timestamps
are JavaScript `Date` serializations (RFC 3339 with milliseconds,
`2026-09-17T19:30:00.123Z`) and nothing is **omitempty**. No example
is captured here because every field is live data.

Methods: `GET`, `HEAD`, `OPTIONS`

#### Responses

| Status | Content-Type | Body | Description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Status](#status) | The current index state. |
| 500 | `text/plain; charset=utf-8` | string | The database query failed. `500 Internal Server Error`, optionally followed by `: <context>`. |

## Schemas

### Status

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `counts` | object | yes | Exact `count(*)` of each table. |
| `counts.packages` | integer | yes |  |
| `counts.versions` | integer | yes |  |
| `counts.variants` | integer | yes |  |
| `counts.variant_ranges` | integer | yes |  |
| `counts.meta` | integer | yes |  |
| `counts.search_terms` | integer | yes |  |
| `counts.commits` | integer | yes |  |
| `oldest_commit` | [CommitRef](#commitref) or null | yes | The first commit on the timeline; `null` when nothing has been imported. |
| `newest_commit` | [CommitRef](#commitref) or null | yes | The newest commit on the timeline (on any system); `null` when nothing has been imported. |
| `last_import_at` | string (RFC 3339) or null | yes | When the most recent evaluation, on any system, was imported; `null` when nothing has been imported. |
| `systems` | array of [SystemStatus](#systemstatus) | yes | Per-system import state, sorted by system name. |
| `database_size_bytes` | integer | yes | `pg_database_size()` of the serving database. |
| `generated_at` | string (RFC 3339) | yes | When these numbers were computed (responses are CDN-cached). |

### CommitRef

One point on the nixpkgs commit timeline.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `seq` | integer | yes | Dense position on the timeline, 1 for the oldest commit. |
| `hash` | string | yes | The nixpkgs commit hash. |
| `committed_at` | string (RFC 3339) | yes | The nixpkgs commit date. |
| `imported_at` | string (RFC 3339) | yes | When the commit row was created in this index. |

### SystemStatus

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `system` | string | yes | Nix system, e.g. `x86_64-linux`. |
| `commits` | integer | yes | Commits with an imported evaluation for this system. |
| `newest` | [CommitRef](#commitref) | yes | The newest commit evaluated for this system. Lower than `newest_commit` for a system no longer indexed. |
| `last_imported_at` | string (RFC 3339) | yes | When that newest evaluation was imported. |
| `nix_version` | string or null | yes | `nix --version` behind the newest evaluation; `null` for rows created by the migration seed. |

### V2Resolve

One resolved version, keyed by system.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Canonical package name. |
| `version` | string | yes |  |
| `summary` | string | yes | The package's one-line description (`meta.description` in nixpkgs). |
| `systems` | map of string → [V2ResolveSystem](#v2resolvesystem) | yes | One entry per Nix system on which this version exists. |

### V2ResolveSystem

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `flake_installable` | [FlakeInstallable](#flakeinstallable) | yes |  |
| `last_updated` | string (RFC 3339) | yes | Commit date of `flake_installable.ref.rev` (RFC 3339, no fractional seconds). |
| `outputs` | array of [Output](#output) | no | The derivation's outputs. **omitempty** — absent when there are none. |

### FlakeInstallable

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | [FlakeRef](#flakeref) | yes |  |
| `attr_path` | string | yes | Attribute path within nixpkgs, e.g. `python311`. When several paths yield the same package the first (alphabetically) is used. |

### FlakeRef

Always a GitHub reference to NixOS/nixpkgs.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"github"` | yes |  |
| `owner` | `"NixOS"` | yes |  |
| `repo` | `"nixpkgs"` | yes |  |
| `rev` | string | yes | 40-character nixpkgs commit hash. |

### Output

A derivation output. Every field is **omitempty**; in particular `default` is only present when `true`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | no | Output name, e.g. `out`, `bin`, `dev`, `man`. |
| `path` | string | no | Nix store path of the output. |
| `default` | boolean | no | Whether the output is installed by default. |

### V2Search

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | The normalized search phrase. |
| `total_results` | integer | yes | Number of entries in `results`. |
| `results` | array of [V2SearchResult](#v2searchresult) | yes |  |

### V2SearchResult

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `summary` | string | yes |  |
| `last_updated` | string (RFC 3339) | yes | Commit date of the package's latest release. |

### V2Pkg

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `summary` | string | yes |  |
| `homepage_url` | string | yes |  |
| `license` | string | yes | SPDX identifier, or the license's short name when it has none. |
| `releases` | array of [V2Release](#v2release) | yes | Newest version first. |

### V2Release

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | string | yes |  |
| `last_updated` | string (RFC 3339) | yes | The newest `date` among `platforms`. |
| `platforms` | array of [V2Platform](#v2platform) | yes | One entry per system (a system with several attribute paths is listed once). |
| `platforms_summary` | string | yes | Display string such as `Linux and macOS (Apple Silicon only)`; empty when no supported platform is present. |
| `outputs_summary` | string | yes | Display string such as `out, debug (Linux only)`; empty when every output is installed by default. |

### V2Platform

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `arch` | string | yes | `x86-64` or `arm64`; empty for other systems. |
| `os` | string | yes | `Linux` or `macOS`; empty for other systems. |
| `system` | string | yes | Nix system, e.g. `aarch64-darwin`. |
| `attribute_path` | string | yes |  |
| `commit_hash` | string | yes | nixpkgs commit of this variant's last change. |
| `date` | string (RFC 3339) | yes |  |
| `outputs` | array of [Output](#output) | yes |  |

### V1PackageVersion

One version of a package. Every field except `name` is **omitempty**.
The top-level fields describe the first system's variant; `systems`
carries the per-system detail.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Canonical package name. Always present. |
| `commit_hash` | string | no | nixpkgs commit hash. |
| `last_updated` | integer | no | Commit date as Unix seconds. |
| `version` | string | no |  |
| `platforms` | array of string | no | Systems the package declares support for (`meta.platforms`), filtered to the four devbox supports. |
| `summary` | string | no |  |
| `description` | string | no | Long description (`meta.longDescription`). |
| `homepage` | string | no |  |
| `license` | string | no |  |
| `systems` | map of string → [V1PackageInfo](#v1packageinfo) | no | Per-system detail, keyed by Nix system. |

### V1PackageInfo

Per-system detail for one version. Every field is **omitempty**.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `commit_hash` | string | no |  |
| `last_updated` | integer | no | Unix seconds. |
| `version` | string | no |  |
| `platforms` | array of string | no |  |
| `summary` | string | no |  |
| `description` | string | no |  |
| `homepage` | string | no |  |
| `license` | string | no |  |
| `system` | string | no |  |
| `store_hash` | string | no | The 32-character hash of the first output's store path. |
| `store_name` | string | no | The derivation's `pname` (`python3` for `python3-3.11.9`). |
| `store_version` | string | no | The derivation's `version`; identical to `version`. |
| `meta_name` | string | no | `meta.name` (usually `<pname>-<version>`). |
| `meta_version` | array of string | no | A single-element array holding `meta.version`. |
| `attr_paths` | array of string | no | Every attribute path yielding this package on this system. |
| `programs` | array of string | no | Main programs (`meta.mainProgram`) of the attribute paths, when set. |
| `broken` | boolean | no | `meta.broken`; present only when `true`. |
| `insecure` | boolean | no | `meta.insecure`; present only when `true`. |

### V1Search

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `num_results` | integer | yes | Number of packages. |
| `packages` | array of [V1SearchPackage](#v1searchpackage) | no | Best match first. **omitempty** — absent when there are no results. |

### V1SearchPackage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `num_versions` | integer | yes |  |
| `versions` | array of [V1PackageVersion](#v1packageversion) | no | Newest first. **omitempty**. |

### Search

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `metadata` | object | yes |  |
| `metadata.total_results` | integer | yes | Number of entries in `results`. |
| `results` | array of [SearchResult](#searchresult) | yes |  |

### SearchResult

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `packages` | array of [SearchPackage](#searchpackage) | yes | One entry per `pname`+`version`, newest first. |

### SearchPackage

Every field is **omitempty**.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `attribute_path` | string | no |  |
| `pname` | string | no | `meta.name` of the derivation. |
| `version` | string | no |  |
| `date` | string (RFC 3339) | no | Commit date (RFC 3339). |
| `nixpkg_commit` | string | no | nixpkgs commit hash. |
