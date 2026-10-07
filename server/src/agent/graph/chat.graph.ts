import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Msg } from '../llm/llm.types';
import type { RetrievedDoc } from '../rag/rag.types';
import { extractTripDate } from '../tools/weather.tool';
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
  // weather 节点产出,仅在问题含具体日期时有值
  weather: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

/** 问题里有具体日期且开关开启时才走天气查询,普通问答不受额外延迟影响。 */
function routeAfterRetrieve(deps: GraphDeps) {
  return (state: ChatState): 'weatherStep' | 'generate' =>
    deps.config.chat.weather.enabled && extractTripDate(state.question) ? 'weatherStep' : 'generate';
}

/** retrieve →(有具体日期?weatherStep)→ generate → END(节点名避开 `weather` 通道) */
function buildChatGraph(deps: GraphDeps) {
  return new StateGraph(ChatAnnotation)
    .addNode('retrieve', nodes.retrieve(deps, { emitProgress: false }) as never)
    .addNode('weatherStep', nodes.weather(deps) as never)
    .addNode('generate', nodes.generate(deps) as never)
    .addEdge(START, 'retrieve')
    .addConditionalEdges('retrieve', routeAfterRetrieve(deps) as never, [
      'weatherStep',
      'generate',
    ])
    .addEdge('weatherStep', 'generate')
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
