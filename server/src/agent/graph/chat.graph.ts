import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Msg } from '../llm/llm.types';
import type { RetrievedDoc } from '../rag/rag.types';
import { ChatState, GraphDeps } from './graph.types';
import { nodes } from './nodes';

/** 问答图状态通道。 */
const ChatAnnotation = Annotation.Root({
  question: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  sessionId: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  history: Annotation<Msg[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  docs: Annotation<RetrievedDoc[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  answer: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  // 阈值全过滤标记(issue #89),retrieve → generate 传递
  filteredEmpty: Annotation<boolean | undefined>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

/** retrieve → generate → END */
function buildChatGraph(deps: GraphDeps) {
  return new StateGraph(ChatAnnotation)
    .addNode('retrieve', nodes.retrieve(deps, { emitProgress: false }) as never)
    .addNode('generate', nodes.generate(deps) as never)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'generate')
    .addEdge('generate', END)
    .compile();
}

export interface ChatGraphInput {
  question: string;
  sessionId: string;
  history: Msg[];
}

/**
 * 运行问答图。token 与 chat:done 由 generate 节点通过 deps.emit 推送。
 */
export async function runChatGraph(
  deps: GraphDeps,
  input: ChatGraphInput,
): Promise<string | undefined> {
  const graph = buildChatGraph(deps);
  const final = await graph.invoke(input as Partial<ChatState>);
  return final?.answer as string | undefined;
}
