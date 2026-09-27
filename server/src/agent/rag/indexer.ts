import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { chunkText } from './chunker';
import { parseMarkdownDoc } from './markdown';
import { Chunk, Embedder } from './rag.types';
import { InMemoryVectorStore } from './store';

export interface IndexOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  /** 混合检索开关(向量 + BM25 RRF),默认启用 */
  hybrid?: boolean;
}

/**
 * 扫描 dataDir 下所有 .md,解析 front-matter + 切块,返回尚未向量化的切块列表。
 * 内存与 pgvector 后端共用此收集逻辑(issue #29)。目录不存在时返回空数组。
 */
export function collectChunksFromDir(dataDir: string, options: IndexOptions = {}): Chunk[] {
  const files = listMarkdownFiles(dataDir);
  const pieces: Chunk[] = [];
  for (const abs of files) {
    const source = toSourcePath(dataDir, abs);
    const raw = readFileSync(abs, 'utf-8');
    const { meta, body } = parseMarkdownDoc(raw, source);
    for (const text of chunkText(body, options.chunkSize, options.chunkOverlap)) {
      pieces.push({ text, source, meta });
    }
  }
  return pieces;
}

/**
 * 扫描 dataDir 下所有 .md,解析 front-matter + 切块 + 向量化,构建内存索引。
 * 目录不存在时返回空索引(降级,不抛错)。
 */
export async function buildIndexFromDir(
  dataDir: string,
  embedder: Embedder,
  options: IndexOptions = {},
): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore({ hybrid: options.hybrid });
  const pieces = collectChunksFromDir(dataDir, options);
  if (!pieces.length) return store;

  // 批量向量化并写入索引
  const vectors = await embedder(pieces.map((p) => p.text));
  pieces.forEach((piece, i) => store.add(piece, vectors[i] ?? []));
  return store;
}

/** 递归列出目录下所有 .md 绝对路径。 */
function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (abs.toLowerCase().endsWith('.md')) out.push(abs);
    }
  };
  walk(dir);
  return out.sort();
}

/** 相对 dataDir 且用正斜杠,跨平台一致的 source 标识。 */
function toSourcePath(dataDir: string, abs: string): string {
  return relative(dataDir, abs).split(sep).join('/');
}
