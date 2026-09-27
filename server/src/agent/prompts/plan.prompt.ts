import { Msg } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';

/** 行程规划 prompt 模板(issue #10 从 graph/nodes.ts 抽出,内容保持逐字一致)。 */

/** 输出 schema 约束(与 agent.types.TravelPlan 对齐)。 */
export const PLAN_SCHEMA_HINT =
  'schema: {"title":string,"days":[{"day":int,"items":[{"time":string,"title":string,"place":string,"description":string}]}],"summary":string,"tips":[string]}';

/** 人设 + schema 约束。 */
export const PLAN_SYSTEM_PROMPT =
  '你是石家庄旅游规划助手。只输出符合给定 JSON schema 的行程,不要多余文字。' + PLAN_SCHEMA_HINT;

/** buildPlanMessages 所需的最小输入(结构化兼容 PlanState['input'])。 */
export interface PlanPromptInput {
  days: number;
  travelers?: number;
  budget?: string;
  interests?: string[];
  preferences?: string;
}

/** 用户需求 + 本地参考资料块。 */
export function formatPlanRequest(input: PlanPromptInput, docs: RetrievedDoc[]): string {
  const context = docs.map((d) => `- ${d.meta.title}:${d.text.slice(0, 120)}`).join('\n');
  return (
    `需求:天数=${input.days},人数=${input.travelers ?? 1},预算=${input.budget ?? 'comfort'},` +
    `兴趣=${(input.interests ?? []).join('/') || '不限'},偏好=${input.preferences ?? '无'}\n` +
    `参考本地资料:\n${context || '(无)'}`
  );
}

export function buildPlanMessages(input: PlanPromptInput, docs: RetrievedDoc[]): Msg[] {
  return [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: formatPlanRequest(input, docs) },
  ];
}

/** 是否本模板发出的行程请求(供 mock 识别:降级到 mock 时也要回合法 JSON,见 issue #60)。 */
export function isPlanPrompt(messages: Msg[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content === PLAN_SYSTEM_PROMPT);
}

/** 从行程请求里读回天数;读不到按 1 天保守处理。 */
export function planRequestedDays(messages: Msg[]): number {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const days = Number(/天数=(\d+)/.exec(user?.content ?? '')?.[1]);
  return Number.isInteger(days) && days > 0 ? days : 1;
}
