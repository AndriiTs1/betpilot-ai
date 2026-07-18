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
      className="flex w-full items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 text-left transition-colors hover:border-slate-700"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#78C85A]/15">
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
        <h2 className="text-xl font-semibold">Новая ставка</h2>
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

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
        <ShieldCheck size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-slate-400" />
        <p className="text-sm text-slate-400">
          Перед подтверждением вы увидите распознанные данные и актуальный коэффициент
        </p>
      </div>
    </div>
  );
}
