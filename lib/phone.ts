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

/**
 * A guest's mobile as typed into a field that starts with "+91 ": also accepts the country code typed twice ("+91
 * +91 98765 43210", "+91 919876543210"; failure-mode audit FM-041). A genuine number starting 91 keeps working.
 */
export function normalizeGuestMobile(input: string): string | null {
  const direct = normalizeIndianMobile(input);
  if (direct) return direct;
  const digits = input.replace(/\D/g, "");
  return /^9191\d{10}$/.test(digits) ? normalizeIndianMobile(`+${digits.slice(2)}`) : null;
}

/** Normalise any valid Indian phone number (landline or mobile) to E.164, or null: branch contact numbers (D-25). */
export function normalizeIndianPhone(input: string): string | null {
  try {
    const pn = parsePhoneNumber(input, { defaultCountry: "IN", extract: false });
    return pn && pn.country === "IN" && !pn.ext && pn.isValid() ? pn.number : null;
  } catch {
    return null;
  }
}

/** Every phone number libphonenumber finds in text, with its E.164 form and character span. */
export function findPhones(text: string): { start: number; end: number; e164: string }[] {
  return findPhoneNumbersInText(text, { defaultCountry: "IN" }).map((m) => ({ start: m.startsAt, end: m.endsAt, e164: m.number.number }));
}

/** "+91 11 4155 0101" style display for a branch phone in E.164. */
export function formatPhone(e164: string): string {
  return parsePhoneNumber(e164)?.formatInternational() ?? e164;
}
