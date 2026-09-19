/**
 * API documentation generator.
 *
 * docs/apis/openapi.yaml is the hand-maintained contract (parameters,
 * response shapes, semantics). Everything that CAN be derived from the code
 * is derived here rather than written twice:
 *
 *   - the route list comes from apps/web/app/⋆⋆/route.ts, and
 *     {@link checkCoverage} fails when it and the spec disagree;
 *   - every `x-example-requests` entry is sent through the real route
 *     handler against the PGlite fixture, so the example responses (status,
 *     headers, body) are captured, not typed.
 *
 * {@link generateApiDocs} renders docs/apis/README.md from the two. The
 * scripts/genApiDocs.ts entry writes it; apiDocs.test.ts asserts the
 * committed copy is current.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { SearchDb } from "./search";
import { createTestDb, seedCommits, seedPackage, type FixturePackage } from "./testDb";

export const WEB_DIR = resolve(import.meta.dirname, "..");
export const APP_DIR = join(WEB_DIR, "app");
export const DOCS_DIR = resolve(WEB_DIR, "../../docs/apis");
export const SPEC_PATH = join(DOCS_DIR, "openapi.yaml");
export const README_PATH = join(DOCS_DIR, "README.md");

// ---------------------------------------------------------------------------
// Spec (the subset of OpenAPI 3.1 this renderer understands)
// ---------------------------------------------------------------------------

export interface Schema {
  /** A type name, or (OpenAPI 3.1) a list of them, e.g. `[string, "null"]`. */
  type?: string | string[];
  oneOf?: Schema[];
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema;
  items?: Schema;
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  format?: string;
}

export interface Parameter {
  name: string;
  in: "query" | "path";
  required?: boolean;
  description?: string;
  schema?: Schema;
  $ref?: string;
}

export interface ResponseSpec {
  description: string;
  content?: Record<string, { schema?: Schema }>;
  $ref?: string;
}

export interface ExampleRequest {
  summary: string;
  path: string;
}

export interface Operation {
  tags?: string[];
  operationId: string;
  summary: string;
  description?: string;
  parameters?: Parameter[];
  responses: Record<string, ResponseSpec>;
  "x-methods"?: string[];
  "x-example-requests"?: ExampleRequest[];
}

export interface Spec {
  info: { title: string; version: string; summary?: string; description?: string };
  servers?: Array<{ url: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, { get: Operation }>;
  components: {
    parameters: Record<string, Parameter>;
    responses: Record<string, ResponseSpec>;
    schemas: Record<string, Schema>;
  };
}

export function loadSpec(path: string = SPEC_PATH): Spec {
  return parseYaml(readFileSync(path, "utf8")) as Spec;
}

// ---------------------------------------------------------------------------
// Route discovery
// ---------------------------------------------------------------------------

export interface Route {
  /** Absolute path of the route.ts module. */
  file: string;
  /** The app-relative route directory, e.g. `pkg/[[...name]]`. */
  fsRoute: string;
  /** The OpenAPI paths this module serves. */
  specPaths: string[];
}

/**
 * Every `route.ts` under the app directory, with the OpenAPI paths it
 * serves. An optional catch-all (`[[...name]]`) serves both the bare path
 * and the parameterized one; `[...name]` and `[name]` map to `{name}`.
 * Route groups (`(group)`) are not part of the URL.
 */
export function discoverRoutes(appDir: string = APP_DIR): Route[] {
  const routes: Route[] = [];
  for (const entry of readdirSync(appDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== "route.ts") continue;
    const file = join(entry.parentPath, entry.name);
    const fsRoute = relative(appDir, entry.parentPath).split(sep).join("/");
    routes.push({ file, fsRoute, specPaths: fsRouteToSpecPaths(fsRoute) });
  }
  return routes.sort((a, b) => (a.fsRoute < b.fsRoute ? -1 : 1));
}

export function fsRouteToSpecPaths(fsRoute: string): string[] {
  const segments = fsRoute === "" ? [] : fsRoute.split("/").filter((s) => !/^\(.*\)$/.test(s));
  let paths = [""];
  for (const segment of segments) {
    const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
    const dynamic = /^\[(.+)\]$/.exec(segment);
    if (optionalCatchAll !== null) {
      paths = paths.flatMap((p) => [p, `${p}/{${optionalCatchAll[1]}}`]);
    } else if (catchAll !== null) {
      paths = paths.map((p) => `${p}/{${catchAll[1]}}`);
    } else if (dynamic !== null) {
      paths = paths.map((p) => `${p}/{${dynamic[1]}}`);
    } else {
      paths = paths.map((p) => `${p}/${segment}`);
    }
  }
  return paths.map((p) => (p === "" ? "/" : p));
}

/** Problems that make the spec and the code disagree; empty when in sync. */
export function checkCoverage(spec: Spec, routes: Route[]): string[] {
  const problems: string[] = [];
  const served = new Map<string, Route>();
  for (const route of routes) for (const p of route.specPaths) served.set(p, route);

  for (const specPath of Object.keys(spec.paths)) {
    if (!served.has(specPath)) problems.push(`spec path ${specPath} has no route.ts under apps/web/app`);
  }
  for (const [specPath, route] of served) {
    if (!(specPath in spec.paths)) {
      problems.push(`route ${route.fsRoute} (${specPath}) is not documented in docs/apis/openapi.yaml`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Example capture
// ---------------------------------------------------------------------------

export interface CapturedExample {
  summary: string;
  method: string;
  path: string;
  status: number;
  /** Headers worth showing, in display order; absent ones are skipped. */
  headers: Array<[string, string]>;
  body: string;
}

/** The headers the docs show, in this order. */
const SHOWN_HEADERS = ["content-type", "cache-control", "etag", "allow", "x-content-type-options"];

/** Two systems keep the examples readable; the shapes are the same at four. */
const DOCS_SYSTEMS = ["aarch64-darwin", "x86_64-linux"];

/**
 * A small corpus at the API's grain: canonical names with several versions
 * and attribute paths, a dotted attribute path, and a near-name for search
 * ranking. Dates and hashes come from {@link seedCommits}, so output is
 * deterministic.
 */
export const DOCS_FIXTURE: FixturePackage[] = [
  {
    name: "python",
    summary: "High-level dynamically-typed programming language",
    homepage: "https://www.python.org",
    license: "PSF-2.0",
    program: "python3",
    versions: [
      { version: "3.12.4", attrPath: "python312", commitSeq: 3 },
      { version: "3.11.9", attrPath: "python311", commitSeq: 2 },
    ],
  },
  {
    name: "go",
    summary: "The Go Programming language",
    homepage: "https://go.dev/",
    license: "BSD-3-Clause",
    program: "go",
    versions: [
      { version: "1.22.5", attrPath: "go", commitSeq: 3 },
      { version: "1.21.11", attrPath: "go_1_21", commitSeq: 1 },
    ],
  },
  {
    name: "go-task",
    summary: "Task runner / simpler Make alternative written in Go",
    homepage: "https://taskfile.dev/",
    license: "MIT",
    program: "task",
    versions: [{ version: "3.38.0", commitSeq: 2 }],
  },
  {
    name: "nodePackages.typescript",
    summary: "A superset of JavaScript that compiles to clean JavaScript output",
    homepage: "https://www.typescriptlang.org/",
    license: "Apache-2.0",
    program: "tsc",
    versions: [{ version: "5.5.4", commitSeq: 3 }],
  },
];

export async function seedDocsFixture(db: SearchDb): Promise<void> {
  await seedCommits(db, 3);
  for (const pkg of DOCS_FIXTURE) {
    await seedPackage(db, { ...pkg, versions: pkg.versions.map((v) => ({ systems: DOCS_SYSTEMS, ...v })) });
  }
}

type RouteModule = Record<string, (request: Request) => Promise<Response>>;

async function loadRouteModules(routes: Route[]): Promise<Map<string, RouteModule>> {
  const modules = new Map<string, RouteModule>();
  for (const route of routes) {
    const mod = (await import(pathToFileURL(route.file).href)) as RouteModule;
    for (const p of route.specPaths) modules.set(p, mod);
  }
  return modules;
}

async function send(mod: RouteModule, method: string, path: string): Promise<Omit<CapturedExample, "summary">> {
  const handler = mod[method];
  if (handler === undefined) throw new Error(`${method} is not exported for ${path}`);
  const response = await handler(new Request(`https://search.devbox.sh${path}`, { method }));
  const headers: Array<[string, string]> = [];
  for (const name of SHOWN_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.push([canonicalHeader(name), value]);
  }
  return { method, path, status: response.status, headers, body: await response.text() };
}

function canonicalHeader(name: string): string {
  if (name === "etag") return "ETag";
  return name.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

export interface Captured {
  /** Keyed by OpenAPI path. */
  byPath: Map<string, CapturedExample[]>;
  /** OPTIONS and POST against one endpoint, for the method-handling section. */
  methods: CapturedExample[];
}

/**
 * Runs every example request in the spec through its route handler against
 * a fresh PGlite database seeded with {@link DOCS_FIXTURE}.
 */
export async function captureExamples(spec: Spec, routes: Route[] = discoverRoutes()): Promise<Captured> {
  const t = await createTestDb();
  try {
    await seedDocsFixture(t.db);
    const modules = await loadRouteModules(routes);

    const byPath = new Map<string, CapturedExample[]>();
    for (const [specPath, item] of Object.entries(spec.paths)) {
      const mod = modules.get(specPath);
      if (mod === undefined) throw new Error(`no route module serves ${specPath}`);
      const examples: CapturedExample[] = [];
      for (const ex of item.get["x-example-requests"] ?? []) {
        examples.push({ summary: ex.summary, ...(await send(mod, "GET", ex.path)) });
      }
      byPath.set(specPath, examples);
    }

    const methodsMod = modules.get("/v2/resolve")!;
    const methods: CapturedExample[] = [
      { summary: "OPTIONS", ...(await send(methodsMod, "OPTIONS", "/v2/resolve")) },
      { summary: "A write method", ...(await send(methodsMod, "POST", "/v2/resolve")) },
    ];
    return { byPath, methods };
  } finally {
    await t.close();
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const REGENERATE = "pnpm --filter @devbox-search/web gen:api-docs";

export function renderMarkdown(spec: Spec, captured: Captured, routes: Route[]): string {
  const out: string[] = [];
  const w = (...lines: string[]): void => void out.push(...lines);

  w(
    "<!-- GENERATED FILE - do not edit. -->",
    "<!-- Source: docs/apis/openapi.yaml; example responses are captured from the route handlers. -->",
    `<!-- Regenerate with: ${REGENERATE} -->`,
    "",
    `# ${spec.info.title} HTTP API`,
    "",
  );
  if (spec.info.summary !== undefined) w(spec.info.summary, "");
  w(
    "This document is generated from [`openapi.yaml`](./openapi.yaml) (the machine-readable contract - load it in",
    "any OpenAPI viewer) plus responses captured by running the route handlers in `apps/web/app` against the",
    "test fixture. Example bodies are pretty-printed here; the service sends compact JSON.",
    "",
  );
  if (spec.info.description !== undefined) w(spec.info.description.trimEnd(), "");

  w("## Endpoints", "", "| Method | Path | Summary | Handler |", "| --- | --- | --- | --- |");
  const routeFor = new Map<string, Route>();
  for (const route of routes) for (const p of route.specPaths) routeFor.set(p, route);
  for (const [path, item] of Object.entries(spec.paths)) {
    const route = routeFor.get(path);
    const handler = route === undefined ? "" : `\`app/${route.fsRoute}/route.ts\``;
    w(`| GET | [\`${path}\`](#${anchor(`GET ${path}`)}) | ${item.get.summary} | ${handler} |`);
  }
  w("");

  w("## Method handling", "");
  w("Captured against `/v2/resolve`; every endpoint except `/readyz` behaves the same way.", "");
  for (const ex of captured.methods) w(...renderExample(ex));

  const tags = spec.tags ?? [];
  for (const tag of tags) {
    const paths = Object.entries(spec.paths).filter(([, item]) => (item.get.tags ?? []).includes(tag.name));
    if (paths.length === 0) continue;
    w(`## ${tag.name}`, "");
    if (tag.description !== undefined) w(tag.description, "");
    for (const [path, item] of paths) w(...renderOperation(spec, path, item.get, captured.byPath.get(path) ?? []));
  }

  w("## Schemas", "");
  for (const [name, schema] of Object.entries(spec.components.schemas)) w(...renderSchema(name, schema));

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderOperation(spec: Spec, path: string, op: Operation, examples: CapturedExample[]): string[] {
  const out: string[] = [`### GET ${path}`, "", `**${op.summary}**`, ""];
  if (op.description !== undefined) out.push(op.description.trimEnd(), "");

  const methods = op["x-methods"] ?? ["GET", "HEAD", "OPTIONS"];
  out.push(`Methods: ${methods.map((m) => `\`${m}\``).join(", ")}`, "");

  const params = (op.parameters ?? []).map((p) => resolveRef(spec, p, "parameters"));
  if (params.length > 0) {
    out.push("#### Parameters", "", "| Name | In | Required | Description |", "| --- | --- | --- | --- |");
    for (const p of params) {
      out.push(`| \`${p.name}\` | ${p.in} | ${p.required === true ? "yes" : "no"} | ${oneLine(p.description ?? "")} |`);
    }
    out.push("");
  }

  out.push("#### Responses", "", "| Status | Content-Type | Body | Description |", "| --- | --- | --- | --- |");
  for (const [status, raw] of Object.entries(op.responses)) {
    const response = resolveRef(spec, raw, "responses");
    const [contentType, content] = Object.entries(response.content ?? {})[0] ?? ["", {}];
    out.push(
      `| ${status} | \`${contentType}\` | ${content.schema === undefined ? "" : typeOf(content.schema)} | ${oneLine(response.description)} |`,
    );
  }
  out.push("");

  if (examples.length > 0) {
    out.push("#### Examples", "");
    for (const ex of examples) out.push(...renderExample(ex));
  }
  return out;
}

function renderExample(ex: CapturedExample): string[] {
  const body = prettyBody(ex.body);
  const headers = ex.headers.map(([k, v]) => `${k}: ${v}`);
  return [
    "<details>",
    `<summary><b>${escapeHtml(ex.summary)}</b> - <code>${escapeHtml(`${ex.method} ${ex.path}`)}</code> → <code>${ex.status}</code></summary>`,
    "",
    "```http",
    `${ex.method} ${ex.path}`,
    "```",
    "",
    "```http",
    `HTTP/1.1 ${ex.status}`,
    ...headers,
    ...(body === "" ? [] : ["", body]),
    "```",
    "",
    "</details>",
    "",
  ];
}

function prettyBody(body: string): string {
  if (body === "") return "";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.trimEnd();
  }
}

function renderSchema(name: string, schema: Schema): string[] {
  const out: string[] = [`### ${name}`, ""];
  if (schema.description !== undefined) out.push(schema.description.trimEnd(), "");
  if (schema.type === "array") {
    out.push(`Array of ${typeOf(schema.items ?? {})}.`, "");
    return out;
  }
  if (schema.properties === undefined) {
    out.push(`Type: ${typeOf(schema)}`, "");
    return out;
  }
  out.push("| Field | Type | Required | Description |", "| --- | --- | --- | --- |");
  out.push(...renderProperties(schema, ""));
  out.push("");
  return out;
}

/** Table rows for an object's properties; inline objects nest with a dotted prefix. */
function renderProperties(schema: Schema, prefix: string): string[] {
  const rows: string[] = [];
  const required = new Set(schema.required ?? []);
  for (const [field, prop] of Object.entries(schema.properties ?? {})) {
    const name = prefix + field;
    rows.push(
      `| \`${name}\` | ${typeOf(prop)} | ${required.has(field) ? "yes" : "no"} | ${oneLine(prop.description ?? "")} |`,
    );
    if (prop.properties !== undefined && prop.$ref === undefined) rows.push(...renderProperties(prop, `${name}.`));
  }
  return rows;
}

/** A short type label, linking component schemas to their section. */
function typeOf(schema: Schema): string {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.split("/").pop()!;
    return `[${name}](#${anchor(name)})`;
  }
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (schema.enum !== undefined) return schema.enum.map((v) => `\`${String(v)}\``).join(" \\| ");
  if (schema.oneOf !== undefined) return schema.oneOf.map(typeOf).join(" or ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => typeOf({ ...schema, type })).join(" or ");
  switch (schema.type) {
    case "array":
      return `array of ${typeOf(schema.items ?? {})}`;
    case "object":
      if (schema.additionalProperties !== undefined) return `map of string → ${typeOf(schema.additionalProperties)}`;
      return "object";
    case "string":
      return schema.format === "date-time" ? "string (RFC 3339)" : "string";
    default:
      return schema.type ?? "any";
  }
}

function resolveRef<T extends { $ref?: string }>(spec: Spec, value: T, kind: "parameters" | "responses"): T {
  if (value.$ref === undefined) return value;
  const name = value.$ref.split("/").pop()!;
  const resolved = spec.components[kind][name];
  if (resolved === undefined) throw new Error(`unresolved ${value.$ref}`);
  return resolved as unknown as T;
}

/** GitHub-style heading anchor. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** Collapses a description to one table cell. Backslashes go first so an escaped pipe stays escaped. */
function oneLine(text: string): string {
  return text
    .trim()
    .replace(/\s*\n\s*/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The README contents for the current spec and code. Throws when the spec
 * and the route files disagree.
 */
export async function generateApiDocs(): Promise<string> {
  const spec = loadSpec();
  const routes = discoverRoutes();
  const problems = checkCoverage(spec, routes);
  if (problems.length > 0) throw new Error(`API docs are out of sync with the code:\n  ${problems.join("\n  ")}`);
  const captured = await captureExamples(spec, routes);
  return renderMarkdown(spec, captured, routes);
}
