import { randomInt } from "node:crypto";

// Booking references: "NE-" + 8 Crockford base32 characters (40 bits; no I, L, O, U), enforced by a CHECK (D-14).
export const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REF_RE = /^NE-[0-9A-HJKMNP-TV-Z]{8}$/;

export function randomRef(): string {
  let s = "NE-";
  for (let i = 0; i < 8; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return s;
}
