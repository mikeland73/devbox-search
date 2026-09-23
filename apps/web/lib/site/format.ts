/**
 * Formatting shared by every page.
 *
 * All of it is pure string work over values the API already produced: no
 * page computes a fact, it only lays one out. {@link esc} is the single
 * escape hatch — every dynamic string reaching HTML goes through it.
 */

/** HTML-escapes text for an element body or a double-quoted attribute. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Percent-encodes one path segment, leaving it readable where it can be. */
export function segment(s: string): string {
  return encodeURIComponent(s);
}

/** A query string from pairs, skipping empty values. */
export function query(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function integer(n: number): string {
  return n.toLocaleString("en-US");
}

/** Binary units, one decimal: the number Neon's dashboard shows. */
export function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

export function iso(d: Date): string {
  return d.toISOString();
}

/** `2026-09-19 14:03 UTC`, machine-readable underneath. */
export function time(d: Date): string {
  const text = d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `<time datetime="${esc(iso(d))}">${text}</time>`;
}

/** Just the date, `2026-09-19`, with the full instant as the title. */
export function day(d: Date): string {
  return `<time datetime="${esc(iso(d))}" title="${esc(iso(d))}">${d.toISOString().slice(0, 10)}</time>`;
}

/** Coarse "3 hours ago"; the exact instant is always alongside as a title. */
export function relative(d: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute") + " ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour") + " ago";
  const days = Math.round(hours / 24);
  if (days < 60) return plural(days, "day") + " ago";
  const months = Math.round(days / 30.4);
  if (months < 24) return plural(months, "month") + " ago";
  return plural(Math.round(days / 365.25), "year") + " ago";
}

/** {@link relative}, wrapped so the exact instant is one hover away. */
export function ago(d: Date, now: Date): string {
  return `<time datetime="${esc(iso(d))}" title="${esc(iso(d))}">${relative(d, now)}</time>`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** `x86_64-linux` → `x86_64 linux`, so a header can wrap on the space. */
export function shortSystem(system: string): string {
  return system.replace("-", " ");
}

// ---------------------------------------------------------------------------
// The system indicator
// ---------------------------------------------------------------------------

/**
 * The four systems devbox supports, in a fixed display order. Always all
 * four, always in this order: a missing system has to read as a gap in a
 * column, which a list of only the present ones cannot do.
 *
 * i686-linux exists in the index but is not shown here — it is frozen at
 * the migration seed and no devbox user asks for it. Per-system tables
 * still list it when the data has it.
 */
export const INDICATOR_SYSTEMS = [
  { system: "aarch64-darwin", label: "arm<br>mac" },
  { system: "aarch64-linux", label: "arm<br>linux" },
  { system: "x86_64-darwin", label: "x86<br>mac" },
  { system: "x86_64-linux", label: "x86<br>linux" },
] as const;

/** The `<th>`s matching {@link systemCells}. */
export function systemHeaders(): string {
  return INDICATOR_SYSTEMS.map((s) => `<th class="sys" title="${esc(s.system)}">${s.label}</th>`).join("");
}

/** One `<td>` per indicator system: present, or a visible gap. */
export function systemCells(present: Iterable<string>): string {
  const set = new Set(present);
  return INDICATOR_SYSTEMS.map((s) =>
    set.has(s.system)
      ? `<td class="sys"><span class="y" title="${esc(s.system)}">✓</span></td>`
      : `<td class="sys"><span class="n" title="not on ${esc(s.system)}">–</span></td>`,
  ).join("");
}
