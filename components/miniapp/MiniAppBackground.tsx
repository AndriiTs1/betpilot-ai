// Purely decorative, static background — no images, no canvas/SVG assets,
// no animation. Rendered once at the /miniapp layout level so it's shared
// by every BottomNav tab (Bet/Active/History/Balance) and the welcome
// BannerScreen alike, instead of being duplicated per screen.
export default function MiniAppBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Layer 1 — base: deep navy top fading to near-black bottom */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, #08111F 0%, #050916 55%, #02040B 100%)" }}
      />

      {/* Layer 2 — stadium glow: two large, very soft cold-blue glows in the
          top corners, standing in for stadium floodlights without depicting
          any literal lights/photo. */}
      <div
        className="absolute"
        style={{
          top: "-20%",
          left: "-20%",
          width: "70vh",
          height: "70vh",
          background: "radial-gradient(circle, rgba(38,108,160,0.14) 0%, rgba(38,108,160,0) 70%)",
        }}
      />
      <div
        className="absolute"
        style={{
          top: "-20%",
          right: "-20%",
          width: "70vh",
          height: "70vh",
          background: "radial-gradient(circle, rgba(38,108,160,0.14) 0%, rgba(38,108,160,0) 70%)",
        }}
      />

      {/* Layer 3 — central ambient glow: faint brand green + a touch of cyan,
          top-center only, deliberately weak so it never competes with text. */}
      <div
        className="absolute inset-x-0 top-0"
        style={{
          height: "50vh",
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(96,232,74,0.08) 0%, rgba(96,232,74,0) 60%)",
        }}
      />
      <div
        className="absolute inset-x-0 top-0"
        style={{
          height: "40vh",
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(80,170,190,0.06) 0%, rgba(80,170,190,0) 65%)",
        }}
      />

      {/* Layer 4 — sports grid: near-invisible perspective-like grid lines,
          CSS gradients only, alpha kept in the 0.02–0.05 range. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px, transparent 1px, transparent 48px), " +
            "repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px, transparent 1px, transparent 48px)",
        }}
      />

      {/* Layer 5 — vignette: darker edges/bottom so BottomNav stays readable,
          center kept slightly lighter/deeper for the main content area. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 35%, rgba(8,17,31,0) 0%, rgba(2,4,11,0.55) 75%, rgba(2,4,11,0.85) 100%)",
        }}
      />
    </div>
  );
}
