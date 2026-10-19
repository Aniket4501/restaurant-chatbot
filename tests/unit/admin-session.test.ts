import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearedCookie, currentEpoch, issueSession, passwordMatches, readCookie, rotateEpoch, SESSION_MS, sessionCookie, verifySession } from "@/lib/auth/admin-session";
import { decide } from "@/lib/auth/proxy-rules";

const KEY = Buffer.alloc(32, 1);
const OTHER = Buffer.alloc(32, 2);
const NOW = Date.parse("2026-10-16T14:00:00+05:30");

describe("admin session cookie (D-16)", () => {
  it("verifies a fresh cookie and expires it after 8 hours", () => {
    const c = issueSession(KEY, NOW);
    expect(verifySession(c, KEY, NOW + 1000)).toMatchObject({ v: 1, iat: NOW, exp: NOW + SESSION_MS });
    expect(verifySession(c, KEY, NOW + SESSION_MS - 1)).not.toBeNull();
    expect(verifySession(c, KEY, NOW + SESSION_MS)).toBeNull();
  });
  it("rejects a tampered signature, a tampered payload, another key, and junk", () => {
    const c = issueSession(KEY, NOW);
    const [p, s] = c.split(".");
    const flip = (x: string) => (x[0] === "A" ? "B" : "A") + x.slice(1);
    expect(verifySession(`${p}.${flip(s)}`, KEY, NOW)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ v: 1, iat: NOW, exp: NOW + 10 * SESSION_MS, epoch: currentEpoch() })).toString("base64url");
    expect(verifySession(`${forged}.${s}`, KEY, NOW)).toBeNull();
    expect(verifySession(c, OTHER, NOW)).toBeNull();
    for (const junk of ["", "abc", "a.b.c", ".", "x".repeat(600), null, undefined]) expect(verifySession(junk, KEY, NOW)).toBeNull();
  });
  it("rejects a validly signed cookie whose lifetime exceeds 8 hours", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, iat: NOW, exp: NOW + 2 * SESSION_MS, epoch: currentEpoch() })).toString("base64url");
    expect(verifySession(`${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`, KEY, NOW)).toBeNull();
  });
  it("revokes every earlier cookie on sign-out (epoch rotation); the proxy ignores the epoch", () => {
    const c = issueSession(KEY, NOW);
    rotateEpoch();
    expect(verifySession(c, KEY, NOW)).toBeNull();
    expect(verifySession(c, KEY, NOW, null)).not.toBeNull();
    expect(verifySession(issueSession(KEY, NOW), KEY, NOW)).not.toBeNull();
  });
  it("compares passwords in constant time over digests", () => {
    expect(passwordMatches("correct horse battery", "correct horse battery")).toBe(true);
    expect(passwordMatches("correct horse batter", "correct horse battery")).toBe(false);
    expect(passwordMatches("", "x")).toBe(false);
  });
  it("sets HttpOnly, SameSite=Strict, Path=/ and an 8-hour Max-Age; clears with Max-Age=0", () => {
    expect(sessionCookie("v")).toBe("ne_admin=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800");
    expect(clearedCookie()).toBe("ne_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect(readCookie("a=1; ne_admin=abc.def; b=2")).toBe("abc.def");
    expect(readCookie("ne_admin_x=1")).toBeNull();
  });
});

describe("proxy rules (D-16)", () => {
  const cookie = issueSession(KEY, NOW);
  const base = { method: "GET", pathname: "/api/availability", host: "127.0.0.1:3100", origin: null, cookie: null };
  it.each(["evil.example:3100", "192.168.1.5:3100", "127.0.0.1.evil.com", null])("refuses Host %s", (host) => {
    expect(decide({ ...base, host }, KEY, NOW)).toMatchObject({ action: "deny", status: 403 });
  });
  it.each(["127.0.0.1:3100", "localhost:3100", "[::1]:3100", "127.0.0.1"])("accepts loopback Host %s", (host) => {
    expect(decide({ ...base, host }, KEY, NOW)).toEqual({ action: "next" });
  });
  it("requires a same-origin Origin on state-changing requests", () => {
    const post = { ...base, method: "POST", pathname: "/api/reservations" };
    expect(decide({ ...post, origin: "http://127.0.0.1:3100" }, KEY, NOW)).toEqual({ action: "next" });
    expect(decide({ ...post, origin: "http://127.0.0.1:5173" }, KEY, NOW)).toMatchObject({ action: "deny", status: 403 });
    expect(decide({ ...post, origin: "https://evil.example" }, KEY, NOW)).toMatchObject({ action: "deny", status: 403 });
    expect(decide({ ...post, origin: null }, KEY, NOW)).toMatchObject({ action: "deny", status: 403 });
  });
  it("gates admin APIs on a valid cookie but lets sign-in through", () => {
    const list = { ...base, pathname: "/api/admin/reservations" };
    expect(decide(list, KEY, NOW)).toMatchObject({ action: "deny", status: 401 });
    expect(decide({ ...list, cookie }, KEY, NOW)).toEqual({ action: "next" });
    expect(decide({ ...list, cookie }, KEY, NOW + SESSION_MS + 1)).toMatchObject({ action: "deny", status: 401 });
    expect(decide({ ...base, method: "POST", pathname: "/api/admin/session", origin: "http://127.0.0.1:3100" }, KEY, NOW)).toEqual({ action: "next" });
    expect(decide({ ...base, method: "DELETE", pathname: "/api/admin/session", origin: "http://127.0.0.1:3100" }, KEY, NOW)).toMatchObject({ action: "deny", status: 401 });
  });
  it("lets unconfigured admin through to the handler, which answers 503", () => {
    expect(decide({ ...base, pathname: "/api/admin/reservations" }, null, NOW)).toEqual({ action: "next" });
  });
  it("redirects admin pages to the sign-in page without a cookie", () => {
    expect(decide({ ...base, pathname: "/admin" }, KEY, NOW)).toEqual({ action: "redirect", to: "/admin/login" });
    expect(decide({ ...base, pathname: "/admin/anything" }, KEY, NOW)).toEqual({ action: "redirect", to: "/admin/login" });
    expect(decide({ ...base, pathname: "/admin/login" }, KEY, NOW)).toEqual({ action: "next" });
    expect(decide({ ...base, pathname: "/admin", cookie }, KEY, NOW)).toEqual({ action: "next" });
  });
});
