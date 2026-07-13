interface StatCardProps {
  title: string;
  value: string;
  description?: string;
  icon?: string;
}

export default function StatCard({ title, value, description, icon }: StatCardProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <p className="flex items-center gap-2 text-sm text-slate-400">
        {icon && <i className={`ti ti-${icon}`} aria-hidden="true" />}
        {title}
      </p>

      <h2 className="mt-3 text-3xl font-bold text-white">{value}</h2>

      {description && (
        <p className="mt-2 text-sm text-slate-500">{description}</p>
      )}
    </div>
  );
}
