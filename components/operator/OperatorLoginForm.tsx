"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

// Plain fetch + React state — no third-party auth UI library, per the
// Stage 5.0C design direction. Deliberately generic error copy: the login
// API never distinguishes "unknown phone" from "wrong password" (see
// app/api/operator/auth/login/route.ts), so this form can't leak that
// distinction either, even by accident.
const GENERIC_ERROR = "Invalid phone or password.";
const NETWORK_ERROR = "Unable to connect. Check your internet connection.";

export default function OperatorLoginForm() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/operator/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, password }),
      });

      if (response.ok) {
        // "/" is the Dashboard's real current route (no separate
        // "/dashboard" route exists yet) — see the login page's own note.
        router.push("/");
        return;
      }

      setPassword("");
      setError(GENERIC_ERROR);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="relative w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800">
          <i className="ti ti-lock text-xl text-green-500" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-bold text-white">BetPilot AI</h1>
        <p className="mt-1 text-sm text-slate-400">Operator sign in</p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="operator-phone" className="block text-sm font-medium text-slate-300">
            Phone
          </label>
          <input
            id="operator-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            disabled={isSubmitting}
            placeholder="+41000000000"
            className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-white placeholder:text-slate-600 focus:border-green-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="operator-password" className="block text-sm font-medium text-slate-300">
            Password
          </label>
          <input
            id="operator-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isSubmitting}
            placeholder="••••••••"
            className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-white placeholder:text-slate-600 focus:border-green-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          aria-label="Sign in"
          className="mt-2 rounded-xl bg-green-500 px-5 py-2.5 font-semibold text-black disabled:opacity-50"
        >
          {isSubmitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
