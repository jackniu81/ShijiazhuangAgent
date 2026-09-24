import { RetrievedDoc } from '../rag/rag.types';

/** prompt 模板共享小工具。 */

/** 按出现顺序去重的资料标题。 */
export function uniqueTitles(docs: RetrievedDoc[]): string[] {
  return [...new Set(docs.map((d) => d.meta.title).filter(Boolean))];
}

/** 按出现顺序去重的资料路径(用于 sources 回填)。 */
export function uniqueSources(docs: RetrievedDoc[]): string[] {
  return [...new Set(docs.map((d) => d.source).filter(Boolean))];
}
