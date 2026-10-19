import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// D-12: app code never reads the clock directly; only lib/time may. Booking logic takes `now` as input.
const ROOT = path.resolve(__dirname, "../..");
const SCANNED = ["app", "lib", "components", "proxy.ts"];
const ALLOWED = [path.join("lib", "time") + path.sep];
const CLOCK = /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)/;

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [dir];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) return files(rel);
    return /\.(ts|tsx)$/.test(d.name) ? [rel] : [];
  });
}

describe("clock access", () => {
  it("only lib/time reads the system clock", () => {
    const offenders = SCANNED.flatMap(files)
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) => CLOCK.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
