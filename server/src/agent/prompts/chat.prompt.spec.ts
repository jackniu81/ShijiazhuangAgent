import { Msg } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';
import { buildChatMessages, CHAT_SYSTEM_PROMPT, formatChatContext } from './chat.prompt';

const doc = (title: string, source: string, text = '正文'): RetrievedDoc => ({
  text,
  source,
  score: 1,
  meta: { title, tags: [], source },
});

const msg = (role: Msg['role'], content: string): Msg => ({ role, content });

describe('chat.prompt', () => {
  it('人设保持原样,并追加防幻觉事实性约束(issue #90)', () => {
    expect(CHAT_SYSTEM_PROMPT.startsWith('你是石家庄旅游助手,基于提供的本地资料用中文自然回答,简洁友好。')).toBe(true);
    expect(CHAT_SYSTEM_PROMPT).toContain('票价、开放时间、交通班次等具体事实只能引用参考资料中明确给出的内容');
    expect(CHAT_SYSTEM_PROMPT).toContain('资料未提及,建议出行前核实');
    expect(CHAT_SYSTEM_PROMPT).toContain('禁止编造任何数字或事实');
  });

  it('消息结构:system → history(截断至 turns*2)→ user', () => {
    const history = [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2'), msg('assistant', 'a2')];
    const msgs = buildChatMessages(
      { question: 'q3', history, docs: [doc('正定古城', 'attractions/正定古城.md')] },
      1, // 只保留最后 2 条
    );
    expect(msgs[0]).toEqual({ role: 'system', content: CHAT_SYSTEM_PROMPT });
    expect(msgs.slice(1, -1).map((m) => m.content)).toEqual(['q2', 'a2']);
    expect(msgs[msgs.length - 1].role).toBe('user');
  });

  it('user 消息含 CONTEXT/参考资料/Q 三段,标题去重且 CONTEXT 最多 4 个', () => {
    const docs = [
      doc('A', 'a.md'),
      doc('A', 'a.md'), // 重复标题
      doc('B', 'b.md'),
      doc('C', 'c.md'),
      doc('D', 'd.md'),
      doc('E', 'e.md'), // 第 5 个不进 CONTEXT 行,但资料正文仍保留(与原行为一致)
    ];
    const user = formatChatContext(docs, '怎么去');
    expect(user).toContain('CONTEXT:A、B、C、D\n');
    expect(user).not.toContain('CONTEXT:A、B、C、D、E');
    expect(user).toContain('## A\n正文');
    expect(user).toContain('## E');
    expect(user.endsWith('Q:怎么去')).toBe(true);
  });

  it('无资料时参考资料为空段但格式保持', () => {
    const user = formatChatContext([], '你好');
    expect(user).toContain('CONTEXT:\n');
    expect(user).toContain('Q:你好');
  });

  it('参考资料块整体截断至 2000 字', () => {
    const big = doc('大山', 'big.md', '文'.repeat(3000));
    const user = formatChatContext([big], 'q');
    expect(user.length).toBeLessThan(2100);
  });
});
