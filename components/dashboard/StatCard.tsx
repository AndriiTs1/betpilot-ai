import { formatDisplayNumber } from "@/lib/format/number";

interface StatCardProps {
  title: string;
  value: string;
  description?: string;
  icon?: string;
  accent?: "blue" | "green";
  emphasize?: boolean;
}

const ACCENT_ICON_COLOR: Record<"blue" | "green", string> = {
  blue: "text-blue-400",
  green: "text-green-400",
};

export default function StatCard({
  title,
  value,
  description,
  icon,
  accent = "blue",
  emphasize = false,
}: StatCardProps) {
  return (
    <div
      className={`rounded-2xl border bg-[#0b1220] p-5 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-colors ${
        emphasize ? "border-green-500/30" : "border-slate-800/70"
      }`}
    >
      <p className="flex items-center justify-center gap-2 text-sm text-slate-500">
        {icon && (
          <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5">
            <i className={`ti ti-${icon} text-sm ${ACCENT_ICON_COLOR[accent]}`} aria-hidden="true" />
          </span>
        )}
        {title}
      </p>

      <h2 className="mt-2.5 text-3xl font-bold text-white">{formatDisplayNumber(value)}</h2>

      {description && <p className="mt-1.5 text-sm text-slate-500">{description}</p>}
    </div>
  );
}
