// Purely decorative, static background — no images, no canvas/SVG assets,
// no animation (aside from the inline noise data-URI, which is a static
// texture, not a keyframe animation). Rendered once at the /miniapp layout
// level so it's shared by every BottomNav tab (Bet/Active/History/Balance)
// and the welcome BannerScreen alike, instead of being duplicated per screen.
//
// Layer order (paint order, back to front):
//   A. base vertical gradient
//   B. hero aura (green -> cyan glow, upper-center)
//   C. stadium side lights (left blue/cyan, right green/cyan)
//   D. sports geometry (two diagonal line groups, faded out below the hero)
//   E. arena horizon glow line
//   F. vignette (sides + bottom, hero stays clear)
//   G. subtle monochrome noise texture
export default function MiniAppBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{ minHeight: "100dvh" }}
    >
      {/* A. Base atmosphere */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, #07111F 0%, #050915 42%, #02040A 100%)" }}
      />

      {/* B. Main hero aura — large soft green->cyan glow, upper-center */}
      <div
        className="absolute"
        style={{
          left: "50%",
          top: "8%",
          width: 600,
          height: 600,
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(circle, rgba(69,210,124,0.16) 0%, rgba(31,125,158,0.10) 45%, rgba(31,125,158,0) 75%)",
        }}
      />

      {/* C. Stadium side lights — direct depth/light toward the center */}
      <div
        className="absolute"
        style={{
          left: "-25%",
          top: "8%",
          width: 560,
          height: 560,
          transform: "translate(-50%, -50%)",
          background: "radial-gradient(circle, rgba(40,130,185,0.14) 0%, rgba(40,130,185,0) 70%)",
        }}
      />
      <div
        className="absolute"
        style={{
          left: "125%",
          top: "18%",
          width: 560,
          height: 560,
          transform: "translate(-50%, -50%)",
          background: "radial-gradient(circle, rgba(70,205,150,0.11) 0%, rgba(70,205,150,0) 70%)",
        }}
      />

      {/* D. Sports geometry — two diagonal line groups, visible mainly in the
          upper portion (masked out toward the card area). */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(115deg, rgba(130,220,210,0.045) 0px, rgba(130,220,210,0.045) 1px, transparent 1px, transparent 60px)",
          maskImage: "linear-gradient(180deg, black 0%, black 38%, transparent 68%)",
          WebkitMaskImage: "linear-gradient(180deg, black 0%, black 38%, transparent 68%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(65deg, rgba(130,220,210,0.035) 0px, rgba(130,220,210,0.035) 1px, transparent 1px, transparent 72px)",
          maskImage: "linear-gradient(180deg, black 0%, black 30%, transparent 58%)",
          WebkitMaskImage: "linear-gradient(180deg, black 0%, black 30%, transparent 58%)",
        }}
      />

      {/* E. Arena horizon — soft glowing line separating the hero from the
          content below. */}
      <div
        className="absolute"
        style={{
          left: "50%",
          top: "30%",
          width: "82%",
          height: 2,
          transform: "translate(-50%, -50%)",
          backgroundImage:
            "linear-gradient(90deg, transparent 0%, rgba(90,205,180,0.13) 50%, transparent 100%)",
          filter: "blur(10px)",
        }}
      />

      {/* F. Vignette — darker sides and bottom, hero stays clear */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(2,4,10,0) 52%, rgba(2,4,10,0.55) 80%, rgba(2,4,10,0.92) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(2,4,10,0.5) 0%, rgba(2,4,10,0) 20%, rgba(2,4,10,0) 80%, rgba(2,4,10,0.5) 100%)",
        }}
      />

      {/* G. Subtle monochrome noise texture — static, inline SVG data URI,
          no external asset. */}
      <div
        className="absolute inset-0"
        style={{
          opacity: 0.025,
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}
