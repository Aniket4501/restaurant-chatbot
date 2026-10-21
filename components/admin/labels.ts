// Labels the staff pages share (D-25), matching what the chatbot shows guests (lib/chat/menu.ts, lib/kb/facts.ts).

export const COURSES = [
  { key: "small-plates", label: "Small plates" },
  { key: "tandoor", label: "Tandoor" },
  { key: "mains", label: "Mains" },
  { key: "breads-rice", label: "Breads and rice" },
  { key: "desserts", label: "Desserts" },
  { key: "drinks", label: "Drinks" },
] as const;
export const courseLabel = (k: string) => COURSES.find((c) => c.key === k)?.label ?? k;

export const SPICE = ["Not spicy", "Mild", "Medium spicy", "Hot"];

/** Guest-facing labels from the stored dietary tags (the chat's dish cards use the same rules). */
export function guestLabels(dietary: string[]): { labels: string[]; contains: string[] } {
  const d = dietary;
  return {
    labels: [d.includes("vegan") ? "Vegan" : d.includes("vegetarian") ? "Vegetarian" : null, d.includes("gluten-free") ? "Gluten-free" : null, d.includes("jain-available") ? "Jain option" : null].filter((x): x is string => !!x),
    contains: [d.includes("contains-dairy") ? "dairy" : null, d.includes("contains-nuts") ? "nuts" : null, d.includes("egg") ? "egg" : null].filter((x): x is string => !!x),
  };
}

export const MENU_STATUS: Record<string, { label: string; tone: "good" | "warn" | "neutral" }> = {
  available: { label: "Available", tone: "good" },
  unavailable: { label: "Unavailable", tone: "warn" },
  removed: { label: "Removed from menu", tone: "neutral" },
};

export const FAQ_CATEGORIES = [
  { key: "bookings", label: "Bookings" },
  { key: "food", label: "Food and drink" },
  { key: "payment", label: "Payment" },
  { key: "facilities", label: "Facilities" },
  { key: "house-rules", label: "House rules" },
  { key: "general", label: "General" },
] as const;

export const DOC_TYPES = [
  { key: "overview", label: "Restaurant overview" },
  { key: "branch", label: "Branch information" },
  { key: "hours", label: "Opening hours" },
  { key: "reservations", label: "Reservation policy" },
  { key: "cancellation", label: "Cancellation and changes" },
  { key: "menu", label: "Menu and dietary guidance" },
  { key: "payment", label: "Payment and dining policy" },
  { key: "faq", label: "Questions and answers" },
  { key: "other", label: "Other" },
] as const;

export const shortBranch = (name: string) => name.split(", ").pop()!;
