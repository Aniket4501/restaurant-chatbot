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
