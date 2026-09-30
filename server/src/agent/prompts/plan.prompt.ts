import { Msg } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';
import { truncateAtBoundary } from './util';

/** 行程规划 prompt 模板(issue #10 从 graph/nodes.ts 抽出,内容保持逐字一致)。 */

/** 输出 schema 约束(与 agent.types.TravelPlan 对齐)。 */
export const PLAN_SCHEMA_HINT =
  'schema: {"title":string,"days":[{"day":int,"items":[{"time":string,"title":string,"place":string,"description":string}]}],"summary":string,"tips":[string]}';

/** 人设 + schema 约束 + 防幻觉事实性约束(issue #90)。 */
export const PLAN_SYSTEM_PROMPT =
  '你是石家庄旅游规划助手。只输出符合给定 JSON schema 的行程,不要多余文字。' +
  'items 的 description/tips 中不得出现参考资料未给出的票价、开放时间或交通班次断言;' +
  '资料未覆盖时说明"资料未提及,建议出行前核实",禁止编造数字。' +
  PLAN_SCHEMA_HINT;

/** buildPlanMessages 所需的最小输入(结构化兼容 PlanState['input'])。 */
export interface PlanPromptInput {
  days: number;
  travelers?: number;
  budget?: string;
  interests?: string[];
  preferences?: string;
}

/** 用户需求 + 本地参考资料块(单条按句子边界截 120 字,issue #91)。 */
export function formatPlanRequest(input: PlanPromptInput, docs: RetrievedDoc[]): string {
  const context = docs.map((d) => `- ${d.meta.title}:${truncateAtBoundary(d.text, 120)}`).join('\n');
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

/** 脏输出回炉:把校验器的具体错误连同上次输出一起回喂,让模型定点修而不是重新发挥。 */
export function buildPlanRepairMessages(
  input: PlanPromptInput,
  docs: RetrievedDoc[],
  previousOutput: string,
  reasons: string[],
): Msg[] {
  const feedback =
    `你上一次的输出未通过结构校验,问题:\n` +
    reasons.map((r) => `- ${r}`).join('\n') +
    `\n\n上次输出(节选):\n${previousOutput.slice(0, 1500)}\n\n` +
    `请修正后重新输出,只输出符合 schema 的 JSON,不要任何解释或多余文字。`;
  return [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: formatPlanRequest(input, docs) },
    { role: 'assistant', content: previousOutput.slice(0, 1500) },
    { role: 'user', content: feedback },
  ];
}
