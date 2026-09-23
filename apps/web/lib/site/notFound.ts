/**
 * The site's 404. A page, not the API's plain-text body: someone who
 * followed a stale link should land somewhere they can search from.
 */

import { esc } from "./format";
import { page } from "./layout";
import { searchPath } from "./links";

export function renderNotFoundPage(opts: {
  heading: string;
  detail: string;
  /** Search terms worth offering, e.g. the name that missed. */
  suggest?: string;
  origin: string;
}): string {
  const suggestion =
    opts.suggest === undefined || opts.suggest === ""
      ? ""
      : `<p>Try <a href="${esc(searchPath(opts.suggest))}">searching for ${esc(opts.suggest)}</a>.</p>`;
  return page({
    title: "Not found · nixsearch",
    origin: opts.origin,
    q: opts.suggest ?? "",
    body: `<div class="empty">
  <h1>${esc(opts.heading)}</h1>
  <p class="muted">${esc(opts.detail)}</p>
  ${suggestion}
</div>`,
  });
}
