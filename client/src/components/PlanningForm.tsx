import { useState, type FormEvent } from 'react';
import type { PlanCreatePayload } from '../lib/types';

/**
 * PlanningForm —— 行程规划表单。
 *
 * 字段严格对齐 PlanCreatePayload['input'],submit 时直接 emit,
 * ChatWindow (Step 14) 拿到后只需包一层 requestId 就能喂给 agentSocket.createPlan()。
 */
type Input = PlanCreatePayload['input'];

interface Props {
  onSubmit: (input: Input) => void;
  initial?: Partial<Input>;
  submitting?: boolean;
}

const BUDGET_OPTIONS: { value: NonNullable<Input['budget']>; label: string }[] = [
  { value: 'economy', label: '经济' },
  { value: 'comfort', label: '舒适' },
  { value: 'luxury', label: '豪华' },
];

const INTEREST_OPTIONS = [
  '历史',
  '美食',
  '亲子',
  '文化',
  '自然',
  '红色',
  '宗教',
  '购物',
];

interface FormState {
  days: number;
  startDate: string;
  travelers: number;
  budget: Input['budget'] | '';
  interests: string[];
  preferences: string;
}

export default function PlanningForm({ onSubmit, initial, submitting }: Props) {
  const [state, setState] = useState<FormState>({
    days: initial?.days ?? 2,
    startDate: initial?.startDate ?? '',
    travelers: initial?.travelers ?? 1,
    budget: initial?.budget ?? '',
    interests: initial?.interests ?? [],
    preferences: initial?.preferences ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
  };

  const toggleInterest = (tag: string) => {
    setState((s) => ({
      ...s,
      interests: s.interests.includes(tag)
        ? s.interests.filter((t) => t !== tag)
        : [...s.interests, tag],
    }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    // 校验从 DOM 直接取值,避免 React auto-batching 导致 state 未 flush
    const daysInput = e.currentTarget.querySelector<HTMLInputElement>(
      '[data-testid="days"]'
    );
    const days = Number(daysInput?.value ?? state.days);

    if (days < 1 || days > 7) {
      setError('天数需在 1-7 之间');
      return;
    }

    setError(null);

    const input: Input = {
      days,
      startDate: state.startDate || undefined,
      travelers: state.travelers || undefined,
      budget: state.budget || undefined,
      interests: state.interests.length ? state.interests : undefined,
      preferences: state.preferences.trim() || undefined,
    };

    onSubmit(input);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">📋 规划行程</h3>
        {error && (
          <p className="text-xs text-red-500" data-testid="planning-error">
            {error}
          </p>
        )}
      </div>

      {/* 天数 + 日期 + 人数 — 一行 */}
      <div className="grid grid-cols-3 gap-3">
        <label className="text-xs">
          <span className="mb-1 block font-medium text-slate-600">
            天数 <span className="text-red-500">*</span>
          </span>
          <input
            type="number"
            min={1}
            max={7}
            value={state.days}
            onChange={(e) => set('days', Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            data-testid="days"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium text-slate-600">出发日期</span>
          <input
            type="date"
            value={state.startDate}
            onChange={(e) => set('startDate', e.target.value)}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            data-testid="startDate"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium text-slate-600">人数</span>
          <input
            type="number"
            min={1}
            max={20}
            value={state.travelers}
            onChange={(e) => set('travelers', Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            data-testid="travelers"
          />
        </label>
      </div>

      {/* 预算 */}
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-slate-600">预算</span>
        <select
          value={state.budget}
          onChange={(e) =>
            set('budget', (e.target.value || '') as FormState['budget'])
          }
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          data-testid="budget"
        >
          <option value="">不限</option>
          {BUDGET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {/* 兴趣标签 */}
      <div>
        <span className="mb-1 block text-xs font-medium text-slate-600">兴趣标签</span>
        <div className="flex flex-wrap gap-1.5">
          {INTEREST_OPTIONS.map((tag) => {
            const active = state.interests.includes(tag);
            return (
              <button
                type="button"
                key={tag}
                onClick={() => toggleInterest(tag)}
                data-testid={`interest-${tag}`}
                className={[
                  'rounded-full px-2.5 py-1 text-[11px] transition',
                  active
                    ? 'bg-emerald-500 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                ].join(' ')}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      {/* 备注 */}
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-slate-600">备注</span>
        <textarea
          rows={2}
          value={state.preferences}
          onChange={(e) => set('preferences', e.target.value)}
          placeholder="如:带老人,少爬山 / 想多吃本地小吃"
          className="w-full resize-none rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          data-testid="preferences"
        />
      </label>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-emerald-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '生成中…' : '生成行程'}
        </button>
      </div>
    </form>
  );
}
