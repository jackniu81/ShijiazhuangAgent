import { Msg } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';
import { uniqueTitles } from './util';

/** 旅游问答 prompt 模板(issue #10 从 graph/nodes.ts 抽出,内容保持逐字一致)。 */

/** 人设:问答助手 + 防幻觉事实性约束(issue #90)。 */
export const CHAT_SYSTEM_PROMPT =
  '你是石家庄旅游助手,基于提供的本地资料用中文自然回答,简洁友好。' +
  '票价、开放时间、交通班次等具体事实只能引用参考资料中明确给出的内容;' +
  '资料未覆盖时必须回答"资料未提及,建议出行前核实",禁止编造任何数字或事实。';

/** buildChatMessages 所需的最小输入(结构化兼容 ChatState)。 */
export interface ChatPromptInput {
  question: string;
  history: Msg[];
  docs: RetrievedDoc[];
}

/** 参考资料块:标题 + 正文,整体截断防止超上下文。 */
export function formatChatContext(docs: RetrievedDoc[], question: string): string {
  const contextTitles = uniqueTitles(docs).slice(0, 4);
  return (
    `CONTEXT:${contextTitles.join('、')}\n` +
    `参考资料:\n${docs.map((d) => `## ${d.meta.title}\n${d.text}`).join('\n\n').slice(0, 2000)}\n` +
    `Q:${question}`
  );
}

export function buildChatMessages(input: ChatPromptInput, historyTurns: number): Msg[] {
  const history = input.history.slice(-historyTurns * 2);
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: formatChatContext(input.docs, input.question) },
  ];
}
