import { describe, expect, test } from "vitest";
import { listUnstableReleases, resolveCommit, selectPending, tarballUrl } from "./discover.js";

/** A realistic S3 list-objects-v2 response with delimiter=/. */
function s3Xml(prefixes: string[], nextToken?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>nix-releases</Name><Prefix>nixpkgs/</Prefix><Delimiter>/</Delimiter>
  ${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("\n  ")}
  ${nextToken === undefined ? "" : `<NextContinuationToken>${nextToken}</NextContinuationToken>`}
</ListBucketResult>`;
}

describe("listUnstableReleases", () => {
  test("parses release directories and sorts oldest first", async () => {
    const fetchImpl = (async () =>
      new Response(
        s3Xml([
          "nixpkgs/nixpkgs-25.11pre862851.8f4f0b1c1c9e/",
          "nixpkgs/nixpkgs-24.05pre600000.abcdef1234/",
          // Non-unstable and unrelated prefixes are ignored.
          "nixpkgs/nixos-24.05/",
          "nixpkgs/nixpkgs-unstable/",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const releases = await listUnstableReleases(fetchImpl);
    expect(releases).toEqual([
      { name: "nixpkgs-24.05pre600000.abcdef1234", commitCount: 600000, abbrevHash: "abcdef1234" },
      { name: "nixpkgs-25.11pre862851.8f4f0b1c1c9e", commitCount: 862851, abbrevHash: "8f4f0b1c1c9e" },
    ]);
  });

  test("follows continuation tokens", async () => {
    const pages = [
      s3Xml(["nixpkgs/nixpkgs-24.05pre1.aaaaaaa/"], "TOKEN"),
      s3Xml(["nixpkgs/nixpkgs-24.05pre2.bbbbbbb/"]),
    ];
    let call = 0;
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(pages[call++]!, { status: 200 });
    }) as unknown as typeof fetch;

    const releases = await listUnstableReleases(fetchImpl);
    expect(releases.map((r) => r.abbrevHash)).toEqual(["aaaaaaa", "bbbbbbb"]);
    expect(seen[1]).toContain("continuation-token=TOKEN");
  });

  test("throws on a non-OK response rather than reporting zero releases", async () => {
    // Silently returning [] would make discover a no-op and stall indexing.
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(listUnstableReleases(fetchImpl)).rejects.toThrow(/503/);
  });
});

describe("selectPending", () => {
  const releases = [
    { name: "r1", commitCount: 100, abbrevHash: "aaaaaaa" },
    { name: "r2", commitCount: 200, abbrevHash: "bbbbbbb" },
    { name: "r3", commitCount: 300, abbrevHash: "ccccccc" },
    { name: "r4", commitCount: 400, abbrevHash: "ddddddd" },
    { name: "r5", commitCount: 500, abbrevHash: "eeeeeee" },
  ];

  test("skips known hashes", () => {
    const pending = selectPending(releases, new Set(["aaaaaaa", "bbbbbbb"]));
    expect(pending.map((r) => r.abbrevHash)).toEqual(["ccccccc", "ddddddd", "eeeeeee"]);
  });

  test("caps at the limit, taking the OLDEST first so the timeline stays dense", () => {
    // Taking the newest would leave gaps, and commit seq must be contiguous
    // for the range logic to mean anything.
    const pending = selectPending(releases, new Set(), { limit: 2 });
    expect(pending.map((r) => r.abbrevHash)).toEqual(["aaaaaaa", "bbbbbbb"]);
  });

  test("respects the head commit count", () => {
    const pending = selectPending(releases, new Set(), { headCommitCount: 300 });
    expect(pending.map((r) => r.abbrevHash)).toEqual(["ddddddd", "eeeeeee"]);
  });

  test("returns nothing when everything is known", () => {
    expect(selectPending(releases, new Set(releases.map((r) => r.abbrevHash)))).toEqual([]);
  });
});

describe("resolveCommit", () => {
  test("returns the full hash and committer date", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          sha: "8f4f0b1c1c9e" + "0".repeat(28),
          commit: { committer: { date: "2026-08-01T05:00:00Z" } },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await resolveCommit("8f4f0b1c1c9e", { fetchImpl, token: "t" });
    expect(result.hash).toHaveLength(40);
    expect(result.committedAt.toISOString()).toBe("2026-08-01T05:00:00.000Z");
  });

  test("rate limiting produces an actionable error", async () => {
    const fetchImpl = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(resolveCommit("abc", { fetchImpl })).rejects.toThrow(/GITHUB_TOKEN/);
  });

  test("a response missing the date is an error, not a silent epoch date", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sha: "a".repeat(40) }), { status: 200 })) as unknown as typeof fetch;
    await expect(resolveCommit("abc", { fetchImpl })).rejects.toThrow(/missing sha or committer date/);
  });

  test("sends the token when one is provided", async () => {
    let auth: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>)["Authorization"] ?? null;
      return new Response(
        JSON.stringify({ sha: "a".repeat(40), commit: { committer: { date: "2026-01-01T00:00:00Z" } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await resolveCommit("abc", { fetchImpl, token: "secret" });
    expect(auth).toBe("Bearer secret");
  });
});

describe("tarballUrl", () => {
  test("points at codeload, avoiding a full git clone", () => {
    expect(tarballUrl("a".repeat(40))).toBe(
      `https://codeload.github.com/NixOS/nixpkgs/tar.gz/${"a".repeat(40)}`,
    );
  });
});
