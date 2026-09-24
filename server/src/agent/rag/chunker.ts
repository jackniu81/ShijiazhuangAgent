/**
 * 定长滑窗切块(带重叠),优先在句子边界断开。
 * 中文按字符计,默认 ~500 字/块、重叠 50 字。
 */
export function chunkText(text: string, size = 500, overlap = 50): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // 回退到最近的句子/段落边界,避免硬切
      const slice = clean.slice(start, end);
      const boundary = Math.max(
        slice.lastIndexOf('\n'),
        lastPunctuation(slice),
      );
      if (boundary > size * 0.5) end = start + boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function lastPunctuation(s: string): number {
  return Math.max(
    s.lastIndexOf('。'),
    s.lastIndexOf('！'),
    s.lastIndexOf('？'),
    s.lastIndexOf('.'),
  );
}
