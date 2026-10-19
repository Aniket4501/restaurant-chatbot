import { LIMITS } from "@/lib/config";
import type { ErrorCode } from "@/lib/booking/errors";

// Error envelope (§5.9): { error: { code, message, fields?, …typed extras (D-14) } }.
export function errorResponse(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function okResponse(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Read a JSON body with the D-15 cap: 413 before parsing when larger than 16 KB (header or actual size),
 * 400 BAD_REQUEST for a non-JSON content type or malformed JSON.
 */
export async function readJson(req: Request, maxBytes = LIMITS.bodyBytesMax): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return { ok: false, response: errorResponse(400, "BAD_REQUEST", "Expected a JSON body.") };
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, response: errorResponse(413, "BAD_REQUEST", "Request body too large.") };
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, response: errorResponse(413, "BAD_REQUEST", "Request body too large.") };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, "BAD_REQUEST", "Malformed JSON.") };
  }
}
