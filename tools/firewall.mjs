#!/usr/bin/env node
/**
 * Stages the Vercel WAF rules that rate-limit the API, so the live
 * configuration can be reproduced (or re-applied after a change here)
 * instead of living only in the dashboard. See docs/operations.md.
 *
 * vercel.json can only express deny/challenge rules, not rate limits or
 * bypasses, so these go through the `vercel firewall` CLI. The rules:
 *
 *   1. rate-limit-override  header X-Rate-Limit-Override-Secret == $SECRET
 *                           → bypass (skips every later custom rule)
 *   2. rate-limit-per-ip    path not /readyz (or /readyz/, which the app
 *                           serves as the same route, #45)
 *                           → 1000 requests per 600 s per client IP, 429 over
 *
 * Order matters: bypass only skips rules *after* it. Rules are matched by
 * name and edited in place when they already exist, so re-running is safe.
 * Changes are staged, not published; review with `vercel firewall diff` and
 * apply with `vercel firewall publish`.
 *
 * Usage:
 *   RATE_LIMIT_OVERRIDE_SECRET=... node tools/firewall.mjs
 *   vercel firewall diff --project devbox-search
 *   vercel firewall publish --project devbox-search
 *
 * Needs a logged-in Vercel CLI (v59+) with access to the project. The
 * secret ends up in the firewall configuration, readable by anyone with
 * access to the project; treat it like an environment variable. It is
 * also passed to the CLI as an argument (the CLI takes conditions from
 * argv only, no stdin or env form), so it is briefly visible in the
 * process list of the machine running this.
 */

import { spawnSync } from "node:child_process";

const PROJECT = process.env.VERCEL_PROJECT ?? "devbox-search";
const SCOPE = process.env.VERCEL_SCOPE ?? "mikeland86s-projects";
const OVERRIDE_HEADER = "X-Rate-Limit-Override-Secret";

const secret = process.env.RATE_LIMIT_OVERRIDE_SECRET ?? "";
if (secret === "") {
  console.error("RATE_LIMIT_OVERRIDE_SECRET is required (e.g. openssl rand -hex 32)");
  process.exit(2);
}

const RATE_LIMIT = { limit: 1000, window: 600, keys: ["ip"], algo: "fixed_window", action: "rate_limit" };

const RULES = [
  {
    name: "rate-limit-override",
    description: "Trusted clients skip the per-IP rate limit (see docs/operations.md)",
    condition: { type: "header", key: OVERRIDE_HEADER, op: "eq", value: secret },
    action: "bypass",
    rateLimit: null,
    flags: ["--action", "bypass"],
  },
  {
    name: "rate-limit-per-ip",
    description: `${RATE_LIMIT.limit} requests per ${RATE_LIMIT.window / 60} minutes per client IP, all paths except /readyz`,
    condition: { type: "path", op: "re", value: "^/readyz/?$", neg: true },
    action: "rate_limit",
    rateLimit: RATE_LIMIT,
    flags: [
      "--action", "rate_limit",
      "--rate-limit-keys", RATE_LIMIT.keys.join(","),
      "--rate-limit-algo", RATE_LIMIT.algo,
      "--rate-limit-window", String(RATE_LIMIT.window),
      "--rate-limit-requests", String(RATE_LIMIT.limit),
      "--rate-limit-action", RATE_LIMIT.action,
    ],
  },
];

/**
 * Runs a `vercel firewall` subcommand. Returns stdout; everything else the
 * CLI prints (it writes most of its narration, including the rule's
 * conditions, to stderr) is echoed with the secret scrubbed.
 */
function vercel(...args) {
  const res = spawnSync("vercel", ["firewall", ...args, "--project", PROJECT, "--scope", SCOPE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error !== undefined) {
    // The binary itself could not be run; stdout/stderr are null then.
    console.error(`could not run vercel (is the Vercel CLI installed and on PATH?): ${res.error.message}`);
    process.exit(1);
  }
  process.stderr.write(res.stderr.replaceAll(secret, "<secret>"));
  if (res.status !== 0) {
    process.stderr.write(res.stdout.replaceAll(secret, "<secret>"));
    process.exit(res.status ?? 1);
  }
  return res.stdout;
}

/** JSON with object keys sorted, so two shapes compare regardless of key order. */
function canon(value) {
  return JSON.stringify(value, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

/** Whether a live rule already matches the definition, so no draft is needed. */
function upToDate(live, rule) {
  const mitigate = live.action?.mitigate ?? {};
  return (
    live.active === true &&
    live.description === rule.description &&
    canon(live.conditionGroup) === canon([{ conditions: [rule.condition] }]) &&
    mitigate.action === rule.action &&
    mitigate.actionDuration == null &&
    canon(mitigate.rateLimit) === canon(rule.rateLimit)
  );
}

const live = new Map(JSON.parse(vercel("rules", "list", "--json")).rules.map((r) => [r.name, r]));

for (const rule of RULES) {
  const current = live.get(rule.name);
  if (current !== undefined && upToDate(current, rule)) {
    console.log(`${rule.name}: up to date`);
    continue;
  }
  const args = [
    "rules", current === undefined ? "add" : "edit", rule.name,
    "--description", rule.description,
    "--condition", JSON.stringify(rule.condition),
    ...rule.flags,
    "--yes",
  ];
  vercel(...args);
}

// The bypass must be evaluated before the limit it bypasses.
vercel("rules", "reorder", RULES[0].name, "--first", "--yes");
vercel("diff");
