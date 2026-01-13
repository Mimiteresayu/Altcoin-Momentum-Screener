import { ReactNode } from "react";
import { clsx } from "clsx";

interface MetricCardProps {
  label: string;
  value: string;
  trend?: number;
  icon?: ReactNode;
  loading?: boolean;
}

export function MetricCard({ label, value, trend, icon, loading }: MetricCardProps) {
  const isPositive = trend && trend > 0;
  const isNegative = trend && trend < 0;

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-white/5 rounded-xl p-5 shadow-lg shadow-black/10">
      <div className="flex justify-between items-start mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        {icon && <div className="text-muted-foreground/50">{icon}</div>}
      </div>
      
      {loading ? (
        <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
      ) : (
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold font-mono tracking-tight text-foreground">{value}</span>
          {trend !== undefined && (
            <span className={clsx(
              "text-xs font-bold px-1.5 py-0.5 rounded flex items-center",
              isPositive ? "text-up bg-up/10" : isNegative ? "text-down bg-down/10" : "text-muted-foreground"
            )}>
              {trend > 0 ? "+" : ""}{trend}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
