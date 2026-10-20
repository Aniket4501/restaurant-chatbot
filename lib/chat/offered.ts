import { isOpenStart } from "@/lib/booking/availability";
import { loadAvailabilityData } from "@/lib/booking/load";
import type { Block } from "@/lib/chat/types";
import type { DB } from "@/lib/db/client";
import { localDateOf } from "@/lib/time/tz";

// INV-03 support (§6.4): re-check every offered start against the availability engine at the moment it was shown.
// Used by the eval runner after each turn and, in test mode only, by /api/chat for the E2E trace (D-12).

export type Offered = { branch: string; startsAt: number; partySize: number; open: boolean };

/** INV-03 helper: every start offered in slot, alternative and confirm blocks, checked against the engine now. */
export function offeredStarts(db: DB, blocks: Block[], now: number): Offered[] {
  const out: Offered[] = [];
  const branches = db.prepare("SELECT id, slug, name, timezone, is_active FROM branches").all() as { id: number; slug: string; name: string; timezone: string; is_active: number }[];
  const check = (branch: string, startsAt: number, partySize: number) => {
    const b = branches.find((x) => x.slug === branch);
    if (!b) return out.push({ branch, startsAt, partySize, open: false });
    const date = localDateOf(startsAt, b.timezone);
    const bundle = loadAvailabilityData(db, [date]);
    const row = { id: b.id, slug: b.slug, name: b.name, timezone: b.timezone, isActive: b.is_active === 1 };
    out.push({ branch, startsAt, partySize, open: isOpenStart(bundle, row, date, partySize, startsAt, now) });
  };
  for (const blk of blocks) {
    if (blk.type === "slots") for (const s of [...blk.groups.flatMap((g) => g.slots), ...blk.alternatives]) check(s.branch, s.startsAtMs, blk.partySize);
    if (blk.type === "confirm") check(blk.branch, blk.startsAtMs, blk.partySize);
  }
  return out;
}

