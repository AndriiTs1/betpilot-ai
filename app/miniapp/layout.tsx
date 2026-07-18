import MiniAppBackground from "@/components/miniapp/MiniAppBackground";

export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen text-white">
      <MiniAppBackground />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
