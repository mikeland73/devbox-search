/**
 * Commit discovery: which nixpkgs-unstable commits still need indexing.
 *
 * Port of the S3 listing in internal/nixpkgs/hydra.go, but without the AWS
 * SDK. The `nix-releases` bucket is public and serves plain HTTPS XML, so a
 * fetch + regex is enough — and it avoids a 5 GB git mirror.
 *
 * Release directories look like:
 *   nixpkgs/nixpkgs-25.11pre862851.8f4f0b1c1c9e/
 * giving a commit count (which orders releases) and an abbreviated hash. The
 * full hash and commit date come from the GitHub API, at most a handful of
 * calls per day.
 */

const NIX_RELEASES_URL = "https://nix-releases.s3.eu-west-1.amazonaws.com/";
const GITHUB_COMMIT_URL = "https://api.github.com/repos/NixOS/nixpkgs/commits/";

/** Same expression the Go indexer used. */
const RE_RELEASE = /^nixpkgs\/(nixpkgs-[0-9.]+pre(\d+)\.([0-9a-f]{7,40}))\/$/;

export interface Release {
  name: string;
  commitCount: number;
  abbrevHash: string;
}

export interface DiscoveredCommit {
  hash: string;
  committedAt: Date;
  release: string;
  commitCount: number;
}

/**
 * Lists nixpkgs-unstable releases oldest-first.
 *
 * Uses the S3 REST list-objects-v2 API with delimiter=/ so the response is
 * just the directory prefixes, and follows continuation tokens.
 */
export async function listUnstableReleases(fetchImpl: typeof fetch = fetch): Promise<Release[]> {
  const releases: Release[] = [];
  let continuationToken: string | undefined;

  do {
    const url = new URL(NIX_RELEASES_URL);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", "nixpkgs/");
    url.searchParams.set("delimiter", "/");
    if (continuationToken !== undefined) {
      url.searchParams.set("continuation-token", continuationToken);
    }

    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      throw new Error(`list nix-releases: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();

    for (const prefix of parsePrefixes(xml)) {
      const m = RE_RELEASE.exec(prefix);
      if (m === null) continue;
      releases.push({ name: m[1]!, commitCount: Number(m[2]), abbrevHash: m[3]! });
    }
    continuationToken = matchTag(xml, "NextContinuationToken");
  } while (continuationToken !== undefined);

  // Commit count is a monotonic counter, so it orders releases chronologically.
  releases.sort((a, b) => a.commitCount - b.commitCount);
  return releases;
}

/** Extracts <CommonPrefixes><Prefix>…</Prefix></CommonPrefixes> values. */
function parsePrefixes(xml: string): string[] {
  return [...xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)]
    .map((m) => m[1]!)
    .filter((p) => p !== "nixpkgs/");
}

function matchTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1];
}

/**
 * Resolves an abbreviated hash to the full hash and commit date via the
 * GitHub API. GITHUB_TOKEN is used when present to dodge rate limits.
 */
export async function resolveCommit(
  abbrevHash: string,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ hash: string; committedAt: Date }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "devbox-search-indexer",
  };
  const token = options.token ?? process.env["GITHUB_TOKEN"];
  if (token !== undefined && token !== "") headers["Authorization"] = "Bearer " + token;

  const res = await fetchImpl(GITHUB_COMMIT_URL + abbrevHash, { headers });
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GET commit ${abbrevHash}: ${res.status} (set GITHUB_TOKEN to avoid rate limits)`,
    );
  }
  if (!res.ok) throw new Error(`GET commit ${abbrevHash}: ${res.status} ${res.statusText}`);

  const body = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
  const hash = body.sha;
  const date = body.commit?.committer?.date;
  if (hash === undefined || date === undefined) {
    throw new Error(`GET commit ${abbrevHash}: response missing sha or committer date`);
  }
  return { hash, committedAt: new Date(date) };
}

/**
 * Selects the releases that still need indexing: newer than the database
 * head, oldest first, capped so one bad day can't queue a month of work.
 *
 * The cap is applied to the OLDEST pending releases so the timeline advances
 * without gaps — commit seq must stay dense and ordered.
 */
export function selectPending(
  releases: Release[],
  knownHashes: ReadonlySet<string>,
  options: { limit?: number; headCommitCount?: number } = {},
): Release[] {
  const limit = options.limit ?? 4;
  const head = options.headCommitCount ?? 0;
  const pending = releases.filter(
    (r) => r.commitCount > head && !knownHashes.has(r.abbrevHash),
  );
  return pending.slice(0, limit);
}

/** The codeload tarball URL for a commit — ~45 MB, no git clone needed. */
export function tarballUrl(hash: string): string {
  return `https://codeload.github.com/NixOS/nixpkgs/tar.gz/${hash}`;
}
