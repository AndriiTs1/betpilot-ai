import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OPERATOR_SESSION_COOKIE_NAME, validateOperatorSession } from "@/lib/auth/operatorSession";
import OperatorLoginForm from "@/components/operator/OperatorLoginForm";

// Stage 5.0C decision, documented here rather than left implicit: an
// already-authenticated operator opening this page is redirected to "/"
// (the Dashboard's actual current route — there is no separate "/dashboard"
// route today). This check is local to this page only:
//
// - No global middleware was added for it.
// - "/" itself remains exactly as unprotected as it was before this stage —
//   this redirect only decides what *this page* shows, it doesn't gate
//   anything else.
// - If Stage 5.0D later introduces a real "/dashboard" route as part of
//   protecting it, update the redirect target here to match.
//
// See docs/OPERATOR_AUTH_IMPLEMENTATION.md for the full reasoning.
export default async function OperatorLoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(OPERATOR_SESSION_COOKIE_NAME)?.value ?? null;
  const validation = await validateOperatorSession(token);

  if (validation.valid) {
    redirect("/");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 py-10">
      {/* One restrained radial glow behind the card — the only gradient on
          this page, per the design direction ("restrained use of
          gradients"). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(34,197,94,0.08) 0%, rgba(34,197,94,0) 70%)" }}
      />
      <OperatorLoginForm />
    </main>
  );
}
