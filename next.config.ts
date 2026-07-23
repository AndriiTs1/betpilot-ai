import type { NextConfig } from "next";

// Applied to the operator dashboard and its API surface only — never to
// /miniapp or /api/miniapp/*, which Telegram Web legitimately loads inside
// its own <iframe>; framing those out would break the Mini App in
// production. X-Frame-Options and CSP's frame-ancestors both block
// framing (the former is the legacy header, the latter the modern
// replacement with broader capability) — set together for defense in
// depth across browser versions.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-neon"],

  async headers() {
    return [
      { source: "/", headers: SECURITY_HEADERS },
      { source: "/operator/:path*", headers: SECURITY_HEADERS },
      { source: "/debug/:path*", headers: SECURITY_HEADERS },
      { source: "/api/bets/:path*", headers: SECURITY_HEADERS },
      { source: "/api/dashboard/:path*", headers: SECURITY_HEADERS },
      { source: "/api/operator/:path*", headers: SECURITY_HEADERS },
    ];
  },
};

export default nextConfig;
