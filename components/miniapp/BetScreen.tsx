import {
  ScanLine,
  MessageSquareText,
  ChevronRight,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

interface ActionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

// Visually clickable (native <button>, hover/focus states), but intentionally
// has no onClick — this task is UI-only, no upload/OCR/AI/API wiring yet.
function ActionCard({ icon: Icon, title, description }: ActionCardProps) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-4 rounded-2xl p-4 text-left"
      style={{
        background: "linear-gradient(145deg, rgba(17,29,51,0.88), rgba(9,17,33,0.78))",
        backdropFilter: "blur(14px) saturate(115%)",
        WebkitBackdropFilter: "blur(14px) saturate(115%)",
        border: "1px solid rgba(145,190,220,0.13)",
        boxShadow: "0 14px 40px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.035)",
      }}
    >
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#78C85A]/15"
        style={{ boxShadow: "0 0 18px 2px rgba(120,200,90,0.22)" }}
      >
        <Icon size={24} strokeWidth={2} color="#78C85A" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-white">{title}</p>
        <p className="mt-1 text-sm text-slate-400">{description}</p>
      </div>

      <ChevronRight size={20} strokeWidth={2} className="shrink-0 text-slate-500" />
    </button>
  );
}

// Placeholder only — no upload form, no OCR/AI logic, no API calls wired up
// yet. Real submission flow will be designed in a separate task.
export default function BetScreen() {
  return (
    <div>
      <div className="text-center">
        <h2 className="text-xl font-semibold">Делайте ставки на спорт</h2>
        <p className="mt-2 text-sm text-slate-400">Выберите удобный способ отправки</p>
      </div>

      <div className="mt-6 space-y-3">
        <ActionCard
          icon={ScanLine}
          title="Скриншот купона"
          description="Загрузите изображение, и BetPilot распознает событие, исход, коэффициент и сумму"
        />

        <ActionCard
          icon={MessageSquareText}
          title="Написать ставку"
          description="Опишите ставку обычным сообщением"
        />
      </div>

      <div
        className="mt-6 flex items-start gap-3 rounded-xl p-4"
        style={{
          background: "rgba(4,9,20,0.40)",
          border: "1px solid rgba(128,165,195,0.12)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      >
        <ShieldCheck size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-slate-400" />
        <p className="text-sm text-slate-400">
          Перед подтверждением вы увидите распознанные данные и актуальный коэффициент
        </p>
      </div>
    </div>
  );
}
