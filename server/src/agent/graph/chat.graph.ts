import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Msg } from '../llm/llm.types';
import type { RetrievedDoc } from '../rag/rag.types';
import { ChatState, GraphDeps, ToolCall, ToolResult } from './graph.types';
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
  toolCalls: Annotation<ToolCall[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  toolResults: Annotation<ToolResult[]>({
    reducer: (prev, next) => [...(prev ?? []), ...(next ?? [])],
    default: () => [],
  }),
});

function routeTools(state: ChatState): 'weather' | 'rag' | 'web' | 'none' {
  const call = state.toolCalls?.[0];
  if (!call) return 'none';
  return call.name === 'weather' ? 'weather'
       : call.name === 'rag_attraction' ? 'rag'
       : call.name === 'web_search' ? 'web'
       : 'none';
}

/** retrieve → analyze → [weather_tool | rag_tool | web_search_tool → analyze]* → generate → END */
function buildChatGraph(deps: GraphDeps) {
  return new StateGraph(ChatAnnotation)
    .addNode('retrieve',        nodes.retrieve(deps, { emitProgress: false }) as never)
    .addNode('analyze',         nodes.analyze(deps) as never)
    .addNode('weather_tool',    nodes.weatherTool(deps) as never)
    .addNode('rag_tool',        nodes.ragTool(deps) as never)
    .addNode('web_search_tool', nodes.webTool(deps) as never)
    .addNode('generate',        nodes.generate(deps) as never)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'analyze')
    .addConditionalEdges('analyze', routeTools, {
      weather: 'weather_tool',
      rag:     'rag_tool',
      web:     'web_search_tool',
      none:    'generate',
    })
    .addEdge('weather_tool',    'analyze')
    .addEdge('rag_tool',        'analyze')
    .addEdge('web_search_tool', 'analyze')
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
