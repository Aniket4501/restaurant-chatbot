import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { factLine, loadFactSource, renderKbFacts, renderStaticFacts, type Fact } from "@/lib/kb/facts";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const probe = read("evals/fixtures/probe-facts.v2.json") as { now: string; staticFacts: { id: string; text: string }[]; kbFacts: { id: string; text: string }[] };
const NOW = Date.parse(probe.now); // Fri 16 Oct 2026, 2:05 PM IST

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(read("evals/fixtures/base.json")), { now: NOW });
});
const all = (now = NOW): Fact[] => {
  const src = loadFactSource(db);
  return [...renderStaticFacts(src, now), ...renderKbFacts(src)];
};
const byId = (facts: Fact[]) => new Map(facts.map((f) => [f.id, f.text]));

describe("fact rendering is byte-compatible with the Phase 2 probe (D-13)", () => {
  it("reproduces every probe fact exactly, apart from the D-10 exception note on weekly hours", () => {
    const mine = byId(all());
    const d10: string[] = [];
    for (const f of [...probe.staticFacts, ...probe.kbFacts]) {
      const text = mine.get(f.id);
      if (text === f.text) continue;
      expect(f.id, `${f.id} differs`).toMatch(/^hours:/);
      expect(text).toBe(`${f.text} Except ${text!.slice(f.text.length + " Except ".length)}`);
      d10.push(f.id);
    }
    expect(d10.sort()).toEqual(["hours:gurugram:tue", "hours:hauz-khas:sat", "hours:hauz-khas:thu"]);
  });

  it("adds only the restaurant fact and the aggregates (D-13)", () => {
    const probeIds = new Set([...probe.staticFacts, ...probe.kbFacts].map((f) => f.id));
    const extra = all()
      .map((f) => f.id)
      .filter((id) => !probeIds.has(id));
    expect(extra.every((id) => /^(restaurant:about|menu-cat:[a-z-]+|menu-diet:[a-z-]+)$/.test(id))).toBe(true);
    expect(extra.length).toBe(1 + 6 + 7);
  });

  it("keeps the probe's order: branches, Monday-first weekly hours, exceptions by date; then menu, FAQ, aggregates", () => {
    const ids = all().map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(["restaurant:about", "branch:hauz-khas", "branch:gurugram"]);
    expect(ids.slice(3, 10)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => `hours:hauz-khas:${d}`));
    expect(ids.filter((i) => i.startsWith("exception:"))).toEqual(["exception:hauz-khas:2026-10-22", "exception:gurugram:2026-10-27", "exception:hauz-khas:2026-10-31"]);
    expect(ids.slice(-13, -7)).toEqual(["small-plates", "tandoor", "mains", "breads-rice", "desserts", "drinks"].map((c) => `menu-cat:${c}`));
    expect(factLine({ id: "faq:wifi", kind: "faq", text: "Q: x A: y" })).toBe("faq:wifi | Q: x A: y");
  });
});

describe("hours facts and the horizon (D-10)", () => {
  it("names each in-horizon exception on its weekday's weekly fact", () => {
    const f = byId(all());
    expect(f.get("hours:hauz-khas:thu")).toBe("Hauz Khas on Thursdays: lunch 12:00 PM–3:30 PM; dinner 7:00 PM–11:00 PM. Except Thu 22 Oct 2026: see exception:hauz-khas:2026-10-22.");
    expect(f.get("hours:hauz-khas:fri")).not.toMatch(/Except/);
    expect(f.get("hours:gurugram:mon")).toBe("Golf Course Road on Mondays: closed for lunch; dinner 7:00 PM–11:00 PM.");
  });

  it("drops exceptions once they are past or beyond the 30-day horizon", () => {
    const later = Date.parse("2026-10-28T09:00:00+05:30");
    const f = byId(all(later));
    expect([...f.keys()].filter((k) => k.startsWith("exception:"))).toEqual(["exception:hauz-khas:2026-10-31"]);
    expect(f.get("hours:hauz-khas:thu")).not.toMatch(/Except/);
    const early = Date.parse("2026-09-25T09:00:00+05:30"); // horizon ends 25 Oct
    expect([...byId(all(early)).keys()].filter((k) => k.startsWith("exception:"))).toEqual(["exception:hauz-khas:2026-10-22"]);
  });

  it("lists two exceptions on the same weekday in date order", () => {
    db.prepare("INSERT INTO hours_exceptions (branch_id, date, service, is_closed, note) VALUES (1, '2026-10-29', NULL, 1, 'Diwali week')").run();
    expect(byId(all()).get("hours:hauz-khas:thu")).toMatch(/ Except Thu 22 Oct 2026: see exception:hauz-khas:2026-10-22; Thu 29 Oct 2026: see exception:hauz-khas:2026-10-29\.$/);
    expect(byId(all()).get("exception:hauz-khas:2026-10-29")).toBe("Hauz Khas on Thu 29 Oct 2026 (special hours replacing the usual ones): closed all day (Diwali week).");
  });
});

describe("aggregate facts are complete (D-13)", () => {
  const src = () => loadFactSource(db);
  const entries = (text: string) => text.split(", cheapest first: ")[1]?.split(". Currently unavailable")[0].replace(/\.$/, "").split("; ") ?? [];
  const price = (e: string) => Number(/₹(\d+)/.exec(e)![1]);

  it("menu-cat lists every available item of the category with its price, cheapest first", () => {
    const f = byId(renderKbFacts(src()));
    for (const c of ["small-plates", "tandoor", "mains", "breads-rice", "desserts", "drinks"]) {
      const items = src().menu.filter((m) => m.category === c);
      const list = entries(f.get(`menu-cat:${c}`)!);
      expect(list.length, c).toBe(items.filter((m) => m.isAvailable).length);
      for (const m of items.filter((x) => x.isAvailable)) expect(list.some((e) => e.startsWith(`${m.name} ₹${m.priceInr}`)), `${c}: ${m.name}`).toBe(true);
      expect(list.map(price)).toEqual([...list.map(price)].sort((a, b) => a - b));
    }
    expect(f.get("menu-cat:tandoor")).toMatch(/^Tandoor on the menu \(7 available\), cheapest first: .*\. Currently unavailable: Tandoori Pomfret\.$/);
    expect(f.get("menu-cat:small-plates")).toContain("Keema Pav Sliders ₹525 (Golf Course Road only)");
  });

  it("menu-diet lists every item with the tag; vegetarian includes vegan items", () => {
    const f = byId(renderKbFacts(src()));
    const menu = src().menu;
    const want: Record<string, (d: string[]) => boolean> = {
      vegetarian: (d) => d.includes("vegetarian") || d.includes("vegan"),
      vegan: (d) => d.includes("vegan"),
      "gluten-free": (d) => d.includes("gluten-free"),
      "jain-available": (d) => d.includes("jain-available"),
      "contains-nuts": (d) => d.includes("contains-nuts"),
      "contains-dairy": (d) => d.includes("contains-dairy"),
      egg: (d) => d.includes("egg"),
    };
    for (const [tag, has] of Object.entries(want)) {
      const text = f.get(`menu-diet:${tag}`)!;
      const list = entries(text);
      const items = menu.filter((m) => has(m.dietary));
      expect(list.length, tag).toBe(items.filter((m) => m.isAvailable).length);
      for (const m of items) expect(text, `${tag}: ${m.name}`).toContain(m.name);
    }
    expect(entries(f.get("menu-diet:vegetarian")!).length).toBe(35);
    expect(f.get("menu-diet:vegan")).toMatch(/^Vegan \(14 available\), cheapest first: Tandoori Roti \(breads and rice\) ₹75; /);
  });

  it("indexes aggregates by a short description, and every other fact by its text", () => {
    const kb = renderKbFacts(src());
    for (const f of kb) {
      if (f.kind === "menu-cat" || f.kind === "menu-diet") expect(f.indexText, f.id).toMatch(/^.+: every.+, with prices, cheapest to most expensive\.$/);
      else expect(f.indexText, f.id).toBeUndefined();
    }
    expect(kb.find((f) => f.id === "menu-diet:jain-available")!.indexText).toBe(
      "Jain option available: every item with a Jain option (made without onion, garlic or root vegetables), with prices, cheapest to most expensive.",
    );
  });

  it("renders the restaurant fact from the restaurant row", () => {
    expect(byId(all()).get("restaurant:about")).toBe(
      "Neem & Ember. Cuisine: Modern Indian: wood-fire grills, tandoor and slow-cooked curries. A fictional two-branch restaurant in Delhi NCR, used for this demo. Branches: Hauz Khas and Golf Course Road.",
    );
  });
});

describe("inactive branches", () => {
  it("leave out the branch, its hours, exceptions and FAQs, and items scoped only to it", () => {
    db.prepare("UPDATE branches SET is_active = 0 WHERE slug = 'gurugram'").run();
    const ids = all().map((f) => f.id);
    expect(ids.filter((i) => i.includes("gurugram"))).toEqual([]);
    expect(ids).not.toContain("menu:keema-pav-sliders"); // Golf Course Road only
    expect(byId(all()).get("restaurant:about")).toMatch(/Branches: Hauz Khas\.$/);
    expect(byId(all()).get("menu-cat:small-plates")).not.toContain("Keema Pav");
  });
});
