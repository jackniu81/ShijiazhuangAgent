import { z } from 'zod';
import { PlanItem, TravelPlan } from '@shijiazhuang-agent/shared';

/**
 * plan 输出的结构校验(issue #59)。
 * 真实 LLM 的 JSON 存在格式漂移:代码块包裹、字段为 null、day 写成字符串、多塞字段。
 * 这里的原则是**类型错必须拦、可规整的小漂移放行**,把"要不要重试"和"要不要兜底"分清楚。
 */

/** 缺失或 null 视为未提供,交给 refinePlan 补默认值。 */
const optStr = z.string().nullish().transform((v) => v ?? undefined);

/** 模型常把序号写成 "1",数值类字段统一收编。 */
const coercedNum = z.union([
  z.number(),
  z.string().trim().transform((v) => Number(v)).pipe(z.number()),
]);

const itemSchema = z.object({
  time: optStr,
  title: z.string({ error: '应为非空字符串' }).trim().min(1, '缺少标题'),
  place: optStr,
  description: optStr,
  tips: optStr,
});

const daySchema = z.object({
  day: coercedNum.optional(),
  items: z.array(itemSchema).min(1, '当日的安排项为空'),
});

const planSchema = z.object({
  title: optStr,
  days: z.array(daySchema).min(1, 'days 为空,没有任何一日行程'),
  summary: optStr,
  tips: z.array(z.string()).nullish().transform((v) => v ?? undefined),
});

/** 校验结果:失败时带上原因与原始输出,后者供回炉 prompt 节选引用。 */
export type PlanValidation =
  | { ok: true; plan: TravelPlan }
  | { ok: false; reasons: string[]; raw: string };

export function validatePlanJson(raw: string, expectedDays: number): PlanValidation {
  const json = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reasons: ['输出不是合法 JSON,无法解析。'], raw };
  }

  const checked = planSchema.safeParse(parsed);
  if (!checked.success) {
    return { ok: false, reasons: checked.error.issues.map(formatIssue), raw };
  }

  const plan = toPlan(checked.data);
  if (plan.days.length > expectedDays) {
    return {
      ok: false,
      reasons: [`天数(${plan.days.length})超出需求(${expectedDays}),请按 ${expectedDays} 天输出。`],
      raw,
    };
  }
  return { ok: true, plan };
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.join('.') || '根对象';
  return `${path}: ${issue.message}`;
}

function toPlan(data: z.infer<typeof planSchema>): TravelPlan {
  const days = data.days.map((d) => ({
    day: d.day ?? 0,
    items: d.items.map(toItem),
  }));
  return { title: data.title ?? '', days, summary: data.summary, tips: data.tips };
}

function toItem(data: z.infer<typeof itemSchema>): PlanItem {
  return {
    time: data.time,
    title: data.title,
    place: data.place,
    description: data.description,
    tips: data.tips,
  };
}

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) return fenced[1].trim();
  const brace = /[\[{][\s\S]*[\]}]/.exec(raw);
  return (brace ? brace[0] : raw).trim();
}
