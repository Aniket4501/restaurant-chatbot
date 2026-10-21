import { branchShortName } from "@/lib/kb/facts";
import { formatPhone } from "@/lib/phone";

// Every fixed guest-facing sentence (§5.7, D-15). Templates never contain model text. When the turn has no single
// known branch, phone templates name both branches (D-15 "branch phones").

export type BranchInfo = { slug: string; name: string; short: string; address: string; phone: string; phoneLabel: string; timezone: string };

export function branchInfo(b: { slug: string; name: string; address: string; phone: string; timezone: string }): BranchInfo {
  return { slug: b.slug, name: b.name, short: branchShortName(b.name), address: b.address, phone: b.phone, phoneLabel: formatPhone(b.phone), timezone: b.timezone };
}

/** "Hauz Khas on +91 11 4155 0101" for one branch, or every branch joined with "or". */
function callText(branches: BranchInfo[]): string {
  return branches.map((b) => `${b.short} on ${b.phoneLabel}`).join(" or ");
}

export const T = {
  fallback: (branches: BranchInfo[]) => `I don't have that information. You can call ${callText(branches)}.`,
  /** An allergy or safety question the facts can't answer (D-28): no promise either way, and who can check. */
  allergyUnknown: "I can't confirm that: our menu labels only list the main allergens. Please ask your server, who can check the dish with the kitchen.",
  manageBooking: (branches: BranchInfo[]) => `To change or cancel, please call ${callText(branches)}.`,
  largeParty: (branches: BranchInfo[]) => `Online bookings are for 1 to 8 guests. For a larger group, please call ${callText(branches)}.`,
  offTopic: "I can help with bookings, hours, locations and the menu.",
  clarify: "Sorry, I didn't quite get that. I can find you a table or answer questions about our hours, branches and menu.",
  greeting: "Hello! How can I help? Ask me about our hours, branches or menu, or plan a visit with the options below.",
  pendingConfirm: "Your table isn't booked yet. Tap Confirm to finish.",
  degraded: "I couldn't work that out just now. You can browse the menu or book a table with the buttons below, or ask again in a moment.",
  degradedBooking: "I couldn't work that out just now. You can carry on with your booking below, or ask again in a moment.",
  askBranch: "Which branch would you like?",
  askDate: "Which date would you like?",
  askPartySize: "How many guests?",
  askAmbiguous: (field: string) =>
    field === "date" ? "Which date did you mean?" : field === "time" ? "Which time did you mean?" : field === "branch" ? "Which branch did you mean?" : "How many guests did you mean?",
  badBranch: "Please choose one of our branches.",
  pastDate: "That date has passed. Which date would you like?",
  pastHorizon: "Bookings open up to 30 days ahead. Which date would you like?",
  branchInactive: "That branch isn't taking bookings right now. Which branch would you like?",
  slotsIntro: (heading: string) => `Here are the open times for ${heading}.`,
  closed: (short: string, dateLabel: string) => `${short} is closed on ${dateLabel}.`,
  noMoreToday: (short: string) => `There are no more times at ${short} today.`,
  fullyBooked: (short: string, dateLabel: string) => `${short} is fully booked on ${dateLabel} for that party size.`,
  timeUnavailable: (timeLabel: string) => `${timeLabel} isn't available.`,
  /** D-24 audit: a service closed for the day by an exception says so, with the restaurant's own note. */
  serviceClosed: (short: string, service: string, dateLabel: string, note: string | null) => `${short} is closed for ${service} on ${dateLabel}${note ? ` (${note.charAt(0).toLowerCase()}${note.slice(1).replace(/\.$/, "")})` : ""}.`,
  windowUnavailable: (window: string, short: string, dateLabel: string) => `${short} has no open ${window} times on ${dateLabel}.`,
  otherOptions: "Here are other options.",
  nearestTimes: "Here are the nearest open times.",
  slotGone: "Sorry, that time is no longer available.",
  couldntCheck: "Sorry, I couldn't check availability just now, so I can't show any times. Please try again in a moment.",
  confirmIntro: "Here are your booking details. Add your name and mobile number, then tap Confirm.",
} as const;
