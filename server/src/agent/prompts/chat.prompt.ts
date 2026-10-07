import { Msg } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';
import { fitDocsToBudget, uniqueTitles } from './util';

/** 旅游问答 prompt 模板(issue #10 从 graph/nodes.ts 抽出,内容保持逐字一致)。 */

/** 参考资料块总预算(与原整体 slice(0,2000) 保持一致)。 */
const CHAT_DOCS_BUDGET = 2000;

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

/** 参考资料块:标题 + 正文,预算内按 doc 逐条装入、单条按句子边界截(issue #91)。 */
export function formatChatContext(docs: RetrievedDoc[], question: string): string {
  const contextTitles = uniqueTitles(docs).slice(0, 4);
  const blocks = docs.map((d) => `## ${d.meta.title}\n${d.text}`);
  return (
    `CONTEXT:${contextTitles.join('、')}\n` +
    `参考资料:\n${fitDocsToBudget(blocks, CHAT_DOCS_BUDGET)}\n` +
    `当前问题:${question}`
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
