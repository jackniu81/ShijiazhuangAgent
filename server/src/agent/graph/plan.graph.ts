import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { PlanCreatePayload, TravelPlan } from '@shijiazhuang-agent/shared';
import type { RetrievedDoc } from '../rag/rag.types';
import { CancelledSignal, GraphDeps, PlanState } from './graph.types';
import { nodes } from './nodes';

/** 行程图状态通道:各节点返回增量,后值覆盖前值。 */
const PlanAnnotation = Annotation.Root({
  input: Annotation<PlanCreatePayload['input']>({
    reducer: (_prev, next) => next,
    default: () => undefined as unknown as PlanCreatePayload['input'],
  }),
  docs: Annotation<RetrievedDoc[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  plan: Annotation<TravelPlan | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

/** retrieve → planStep → refine → done → END(节点名避开 `plan` 通道) */
function buildPlanGraph(deps: GraphDeps) {
  return new StateGraph(PlanAnnotation)
    .addNode('retrieve', nodes.retrieve(deps) as never)
    .addNode('planStep', nodes.plan(deps) as never)
    .addNode('refine', nodes.refine(deps) as never)
    .addNode('done', nodes.done(deps) as never)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'planStep')
    .addEdge('planStep', 'refine')
    .addEdge('refine', 'done')
    .addEdge('done', END)
    .compile();
}

/**
 * 运行行程图。结果与进度、错误均由节点通过 deps.emit 直接推送。
 * @throws CancelledSignal 被取消时向上抛出,供 service 收敛。
 */
export async function runPlanGraph(
  deps: GraphDeps,
  input: PlanCreatePayload['input'],
): Promise<TravelPlan | undefined> {
  const graph = buildPlanGraph(deps);
  const final = await graph.invoke({ input } as Partial<PlanState>);
  return final?.plan as TravelPlan | undefined;
}

export { CancelledSignal };
