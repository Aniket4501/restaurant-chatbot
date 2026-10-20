"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Staff sign-in (§5.9): POST /api/admin/session with the password; 5 attempts per minute on the server.
export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Staff sign-in"
      className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-paper p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
          if (res.status === 204) {
            router.replace("/admin");
            return;
          }
          const j = await res.json().catch(() => null);
          setError(res.status === 401 ? "That password isn't right." : (j?.error?.message ?? "Sign-in failed. Try again."));
        } catch {
          setError("Couldn't reach the server. Check that the app is running and try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="font-display text-2xl">Staff sign-in</h1>
      <label htmlFor="password" className="block text-[15px]">
        Password
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} className="mt-1 block min-h-11 w-full rounded-lg border border-line bg-ash px-3 text-[16px]" />
      </label>
      {error && (
        <p id="login-error" role="alert" className="text-[15px] text-warn">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !password} className="min-h-12 w-full rounded-full bg-neem px-5 text-[16px] font-medium text-white hover:bg-neem-dark disabled:opacity-60">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
