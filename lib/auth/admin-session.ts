import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Admin session cookie (D-16): payload {v, iat, exp = iat + 8h, epoch}, HMAC-SHA256 with ADMIN_SESSION_SECRET,
// compared with timingSafeEqual. Sign-out rotates the in-memory epoch, which revokes every earlier cookie; a
// process restart also starts a fresh epoch. The proxy (a separate module instance) checks signature and
// expiry only; every admin handler re-checks fully, epoch included.

export const ADMIN_COOKIE = "ne_admin";
export const SESSION_MS = 8 * 60 * 60 * 1000;

let epoch = randomUUID();
export const currentEpoch = () => epoch;
export function rotateEpoch(): void {
  epoch = randomUUID();
}

type Payload = { v: 1; iat: number; exp: number; epoch: string };

export function issueSession(key: Buffer, now: number, ep: string = epoch): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, iat: now, exp: now + SESSION_MS, epoch: ep } satisfies Payload)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

/** The payload if the cookie is authentic, unexpired and (when `ep` is given) from the current epoch; else null. */
export function verifySession(value: string | null | undefined, key: Buffer, now: number, ep: string | null = epoch): Payload | null {
  if (!value || value.length > 512) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, sig] = parts;
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (p?.v !== 1 || typeof p.iat !== "number" || typeof p.exp !== "number" || typeof p.epoch !== "string") return null;
  if (p.exp <= now || p.iat > now + 60_000 || p.exp - p.iat > SESSION_MS) return null;
  if (ep !== null && p.epoch !== ep) return null;
  return p;
}

/** Constant-time password check over SHA-256 digests (equal lengths for timingSafeEqual). */
export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(input, "utf8").digest(), createHash("sha256").update(expected, "utf8").digest());
}

// No `Secure`: the app is served over plain http on 127.0.0.1 only (D-07).
export const sessionCookie = (value: string) => `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
export const clearedCookie = () => `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function readCookie(header: string | null, name = ADMIN_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
