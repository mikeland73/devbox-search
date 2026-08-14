/**
 * GET /readyz — health check. Returns the literal "ok" plus a newline as
 * text/plain, matching the Go handler byte for byte (it set
 * Content-Type: text/plain;charset=utf-8 and Content-Length: 3).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response("ok\n", {
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const HEAD = GET;
