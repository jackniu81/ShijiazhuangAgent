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

  it('user 消息含 CONTEXT/参考资料/当前问题 三段,标题去重且 CONTEXT 最多 4 个', () => {
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
    expect(user.endsWith('当前问题:怎么去')).toBe(true);
  });

  it('无资料时参考资料为空段但格式保持', () => {
    const user = formatChatContext([], '你好');
    expect(user).toContain('CONTEXT:\n');
    expect(user).toContain('当前问题:你好');
  });

  it('参考资料块:超预算单条按句子边界截,残句以省略号收尾(issue #91)', () => {
    const sentence = '正定古城位于石家庄北郊,夜景灯光很亮. '; // 22 字
    const big = doc('大山', 'big.md', sentence.repeat(120)); // 2640 字
    const user = formatChatContext([big], 'q');
    expect(user.length).toBeLessThanOrEqual(2110);
    const body = user.split('参考资料:\n')[1].split('\n当前问题:')[0];
    expect(body.endsWith('…')).toBe(true);
    // 不在半句/半词中间收尾:截断点必须落在标点之后
    expect(body.slice(0, -1)).toMatch(/[,，、;:：。!?！？]$/);
  });

  it('预算内逐条装全,短资料之间不会被腰斩(issue #91)', () => {
    const docs = Array.from({ length: 10 }, (_, i) => doc(`D${i}`, `d${i}.md`, `第${i}条资料,内容完整。`));
    const user = formatChatContext(docs, 'q');
    for (const d of docs) expect(user).toContain(d.text);
    expect(user.split('参考资料:\n')[1].split('\n当前问题:')[0]).not.toContain('…');
  });
});
