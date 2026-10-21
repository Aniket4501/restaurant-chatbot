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

// D-25 staff workspace navigation and actions.
export const HomeIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M6.5 10v9.5h11V10M10 19.5v-5h4v5" />
  </svg>
);
export const BookIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 6.5c-2-1.5-5-1.8-7.5-1v13c2.5-.8 5.5-.5 7.5 1 2-1.5 5-1.8 7.5-1v-13c-2.5-.8-5.5-.5-7.5 1Z" />
    <path d="M12 6.5v13" />
  </svg>
);
export const QuestionIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4v.4M12 16.6v.1" />
  </svg>
);
export const ChartIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M4 19.5h16M6.5 16v-4M11 16V8M15.5 16v-6M20 16V5.5" />
  </svg>
);
export const ListIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const CloseIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const SearchIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="11" cy="11" r="6" />
    <path d="m15.5 15.5 4 4" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const AlertIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 4.5 20.5 19h-17L12 4.5Z" />
    <path d="M12 10v4M12 16.6v.1" />
  </svg>
);
export const UploadIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 15.5V5M7.5 9.5 12 5l4.5 4.5M5 15v4h14v-4" />
  </svg>
);
