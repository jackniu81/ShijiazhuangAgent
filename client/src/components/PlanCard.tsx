import type { TravelPlan } from '../lib/types';

interface Props {
  plan: TravelPlan;
}

export default function PlanCard({ plan }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl rounded-tl-sm bg-white shadow-sm ring-1 ring-slate-200">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 px-4 py-3 text-white">
        <p className="text-[11px] opacity-80">📋 行程方案</p>
        <h3 className="mt-0.5 text-base font-semibold">{plan.title}</h3>
      </div>

      {/* Summary */}
      {plan.summary && (
        <p className="border-b border-slate-100 px-4 py-2.5 text-xs leading-relaxed text-slate-600">
          {plan.summary}
        </p>
      )}

      {/* Days */}
      <div className="divide-y divide-slate-100">
        {plan.days.map((d) => (
          <div key={d.day} className="px-4 py-3">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-600">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700">
                D{d.day}
              </span>
              第 {d.day} 天
            </p>
            <ul className="space-y-2 pl-7">
              {d.items.map((item, i) => (
                <li key={i} className="text-xs leading-relaxed">
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    {item.time && (
                      <span className="font-mono text-[10px] text-slate-400">
                        {item.time}
                      </span>
                    )}
                    <span className="font-medium text-slate-800">
                      {item.title}
                    </span>
                    {item.place && (
                      <span className="text-[10px] text-slate-400">
                        @ {item.place}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {item.description}
                    </p>
                  )}
                  {item.tips && (
                    <p className="mt-0.5 text-[10px] text-emerald-600">
                      💡 {item.tips}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Tips */}
      {plan.tips && plan.tips.length > 0 && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          <p className="mb-1.5 text-[11px] font-semibold text-slate-600">
            💡 小贴士
          </p>
          <ul className="space-y-0.5 pl-3 text-[11px] text-slate-500 [list-style:disc]">
            {plan.tips.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
