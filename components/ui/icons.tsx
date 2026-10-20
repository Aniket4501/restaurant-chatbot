// Inline line icons and the brand mark (D-18 / the 2026-10-20 brief: no icon or font packages). Decorative unless
// a label is given; 1.6 px strokes in currentColor.

type P = { className?: string; label?: string };
const svg = (p: P) => ({ className: p.className ?? "h-5 w-5", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...(p.label ? { role: "img", "aria-label": p.label } : { "aria-hidden": true }) });

/** A neem sprig: a stem with paired, slightly serrated leaflets. */
export function LeafMark(p: P) {
  return (
    <svg {...svg(p)}>
      <path d="M12 21.5V5" />
      <path d="M12 5c0-1.6.5-2.6 1.4-3.2" />
      <path d="M12 8.5c-2.6-1.9-4.9-1.5-6-.6 1.4 1.8 3.8 2 6 .6Z" />
      <path d="M12 8.5c2.6-1.9 4.9-1.5 6-.6-1.4 1.8-3.8 2-6 .6Z" />
      <path d="M12 13c-2.8-1.9-5.3-1.5-6.5-.5 1.5 1.9 4.1 2.1 6.5.5Z" />
      <path d="M12 13c2.8-1.9 5.3-1.5 6.5-.5-1.5 1.9-4.1 2.1-6.5.5Z" />
      <path d="M12 17.5c-2.4-1.5-4.4-1.2-5.4-.4 1.2 1.6 3.4 1.8 5.4.4Z" />
      <path d="M12 17.5c2.4-1.5 4.4-1.2 5.4-.4-1.2 1.6-3.4 1.8-5.4.4Z" />
    </svg>
  );
}

export const CalendarIcon = (p: P) => (
  <svg {...svg(p)}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </svg>
);
export const ClockIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const MenuBookIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z" />
    <path d="M5 17.5a2 2 0 0 1 2-2h11M9 8.5h5M9 11.5h5" />
  </svg>
);
export const GuestsIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
    <path d="M15.5 6a3 3 0 0 1 0 5.6M17.5 14.6c1.6.6 2.6 2.1 3 4.4" />
  </svg>
);
export const PinIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.3" />
  </svg>
);
export const ArrowUpIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const ChevronIcon = (p: P & { dir?: "left" | "right" }) => (
  <svg {...svg(p)}>
    <path d={p.dir === "left" ? "M14.5 6 8.5 12l6 6" : "M9.5 6l6 6-6 6"} />
  </svg>
);
export const CheckIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.4 4.6-5" />
  </svg>
);
/** A covered dish (cloche), for "Help me find a dish". */
export const DishIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M4 17h16M5.5 17a6.5 6.5 0 0 1 13 0" />
    <path d="M12 8.5V7M10.5 7h3M3 20h18" />
  </svg>
);
