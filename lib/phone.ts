import parsePhoneNumber, { findPhoneNumbersInText } from "libphonenumber-js/max";

// The single server-only phone module (D-09). `/max` metadata is needed to tell mobiles from landlines for
// India (PH-02); some valid mobile ranges are typed FIXED_LINE_OR_MOBILE under /max (PH-03). The same module
// finds phones in text for grounding and masking, because `/mobile` would miss landlines (PH-04).

/** Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX), or null if it isn't one (BR-09). */
export function normalizeIndianMobile(input: string): string | null {
  const pn = parsePhoneNumber(input, { defaultCountry: "IN", extract: false });
  if (!pn || pn.country !== "IN" || pn.ext || !pn.isValid()) return null;
  const type = pn.getType();
  return type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE" ? pn.number : null;
}

/** Every phone number libphonenumber finds in text, with its E.164 form and character span. */
export function findPhones(text: string): { start: number; end: number; e164: string }[] {
  return findPhoneNumbersInText(text, { defaultCountry: "IN" }).map((m) => ({ start: m.startsAt, end: m.endsAt, e164: m.number.number }));
}

/** "+91 11 4155 0101" style display for a branch phone in E.164. */
export function formatPhone(e164: string): string {
  return parsePhoneNumber(e164)?.formatInternational() ?? e164;
}
