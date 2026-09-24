import { DocMeta } from './rag.types';

/** 解析结果:front-matter 元数据 + 去头的正文。 */
export interface ParsedDoc {
  meta: DocMeta;
  body: string;
}

/**
 * 解析带 YAML 风格 front-matter 的 markdown 文档。
 * 仅支持本项目用到的子集:`key: value` 与 `key: [a, b, c]`。
 * @param raw   文件原始内容
 * @param source 相对 data/ 的路径,用于回填 sources
 */
export function parseMarkdownDoc(raw: string, source: string): ParsedDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const frontMatter = match ? match[1] : '';
  const body = (match ? match[2] : raw).trim();

  const fields = new Map<string, string | string[]>();
  for (const line of frontMatter.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    fields.set(key, value.startsWith('[') ? parseList(value) : value);
  }

  const title = (fields.get('title') as string) || titleFromBody(body) || basename(source);
  const tags = (fields.get('tags') as string[]) ?? [];
  const region = (fields.get('region') as string) || undefined;

  return { meta: { title, tags, region, source }, body };
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function titleFromBody(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body);
  return m?.[1].trim();
}

function basename(path: string): string {
  const file = path.split(/[/\\]/).pop() ?? path;
  return file.replace(/\.md$/i, '');
}
