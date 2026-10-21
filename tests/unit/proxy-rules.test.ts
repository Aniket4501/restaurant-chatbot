import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "@/lib/auth/proxy-rules";

// proxy.ts (D-16, D-22): loopback hosts only, and same-origin for every state-changing request. No password.
const base = { method: "GET", host: "127.0.0.1:3100", origin: null };

describe("proxy rules", () => {
  it("allows only loopback hosts (DNS rebinding)", () => {
    for (const host of ["evil.example", "evil.example:3100", "192.168.1.5:3100", "127.0.0.1.evil.example", null]) expect(decide({ ...base, host })).toMatchObject({ action: "deny", status: 403 });
    for (const host of ["127.0.0.1", "127.0.0.1:3100", "localhost:3100", "[::1]:3100"]) expect(decide({ ...base, host })).toEqual({ action: "next" });
  });
  it("requires a same-origin Origin on state-changing requests", () => {
    const post = { ...base, method: "POST" };
    expect(decide({ ...post, origin: "http://127.0.0.1:3100" })).toEqual({ action: "next" });
    expect(decide({ ...post, origin: "http://127.0.0.1:5173" })).toMatchObject({ action: "deny", status: 403 });
    expect(decide({ ...post, origin: "https://evil.example" })).toMatchObject({ action: "deny", status: 403 });
    expect(decide({ ...post, origin: null })).toMatchObject({ action: "deny", status: 403 });
    expect(decide({ ...base, method: "PATCH", origin: "https://evil.example" })).toMatchObject({ action: "deny", status: 403 });
  });
  it("lets reads of the staff pages and APIs through without any sign-in (D-22)", () => {
    expect(decide(base)).toEqual({ action: "next" });
  });
});

// Failure-mode audit FM-018 (scenario 18): no sign-in by decision D-22, so what keeps staff routes local is the loopback
// bind and these rules.
describe("failure-mode audit FM-018", () => {
  it("FM-018 refuses opaque, other-port and look-alike origins on writes, and the server only listens on loopback", () => {
    const patch = { ...base, method: "PATCH" };
    for (const origin of ["null", "http://localhost:3000", "http://127.0.0.1.evil.example:3100", "file://"]) expect(decide({ ...patch, origin }), origin).toMatchObject({ action: "deny", status: 403 });
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const k of ["dev", "start"]) expect(pkg.scripts[k], k).toMatch(/ -H 127\.0\.0\.1(?: |$)/);
  });
});

