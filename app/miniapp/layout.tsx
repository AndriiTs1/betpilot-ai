import MiniAppBackground from "@/components/miniapp/MiniAppBackground";
import { LocaleProvider } from "@/components/miniapp/LocaleProvider";

export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen text-white">
      <MiniAppBackground />
      <div className="relative z-10">
        <LocaleProvider>{children}</LocaleProvider>
      </div>
    </div>
  );
}
