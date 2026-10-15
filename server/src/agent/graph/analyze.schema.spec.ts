import {
  daysFromToday,
  localDateStr,
  parseAnalyzeToolCalls,
  selectAnalyzeToolCall,
} from './analyze.schema';

// 固定"今天"= 2026-10-13(本地日历),避免用例随运行日期漂移
const NOW = new Date(2026, 9, 13, 10, 0, 0);

describe('daysFromToday', () => {
  it('今天=0、明天=1、后天=2', () => {
    expect(daysFromToday('2026-10-13', NOW)).toBe(0);
    expect(daysFromToday('2026-10-14', NOW)).toBe(1);
    expect(daysFromToday('2026-10-15', NOW)).toBe(2);
  });

  it('过去日期为负数,5 天外为 6', () => {
    expect(daysFromToday('2026-10-12', NOW)).toBe(-1);
    expect(daysFromToday('2026-10-19', NOW)).toBe(6);
  });

  it('非法/越界输入 → null', () => {
    expect(daysFromToday(undefined, NOW)).toBeNull();
    expect(daysFromToday('后天', NOW)).toBeNull();
    expect(daysFromToday('2026-13-40', NOW)).toBeNull();
  });

  it('localDateStr 按本地日历输出 YYYY-MM-DD', () => {
    expect(localDateStr(NOW)).toBe('2026-10-13');
  });
});

describe('parseAnalyzeToolCalls', () => {
  it('解析合法 JSON', () => {
    const calls = parseAnalyzeToolCalls('{"toolCalls":[{"name":"weather","params":{"date":"2026-10-14"}}]}');
    expect(calls).toEqual([{ name: 'weather', params: { date: '2026-10-14' } }]);
  });

  it('容忍 ```json 代码块包裹与前后多余文字', () => {
    const raw = '好的,判断如下:\n```json\n{"toolCalls":[{"name":"rag_attraction","params":{"attraction":"赵云庙"}}]}\n```\n';
    expect(parseAnalyzeToolCalls(raw)).toEqual([
      { name: 'rag_attraction', params: { attraction: '赵云庙' } },
    ]);
  });

  it('非法 JSON / 缺 toolCalls → []', () => {
    expect(parseAnalyzeToolCalls('我觉得不需要工具')).toEqual([]);
    expect(parseAnalyzeToolCalls('{"foo":1}')).toEqual([]);
  });

  it('逐项丢弃非法 name 与非对象 params', () => {
    const raw = JSON.stringify({
      toolCalls: [
        { name: 'search', params: {} },
        { name: 'weather', params: '2026-10-14' },
        { name: 'weather', params: { date: '2026-10-14' } },
        { name: 'rag_attraction' },
      ],
    });
    expect(parseAnalyzeToolCalls(raw)).toEqual([
      { name: 'weather', params: { date: '2026-10-14' } },
    ]);
  });
});

describe('selectAnalyzeToolCall', () => {
  const baseCtx = () => ({
    weatherEnabled: true,
    webSearchEnabled: true,
    docTitles: new Set<string>(['正定古城']),
    weatherDone: false,
    ragDone: new Set<string>(),
    webDone: new Set<string>(),
    now: NOW,
  });

  it('weather:开关关闭/日期超范围/已查过 → 均不选中', () => {
    const ctxOff = baseCtx();
    ctxOff.weatherEnabled = false;
    expect(
      selectAnalyzeToolCall([{ name: 'weather', params: { date: '2026-10-14' } }], ctxOff),
    ).toBeUndefined();

    expect(
      selectAnalyzeToolCall([{ name: 'weather', params: { date: '2026-10-19' } }], baseCtx()),
    ).toBeUndefined();
    expect(
      selectAnalyzeToolCall([{ name: 'weather', params: { date: '2026-10-12' } }], baseCtx()),
    ).toBeUndefined();

    const ctxDone = baseCtx();
    ctxDone.weatherDone = true;
    expect(
      selectAnalyzeToolCall([{ name: 'weather', params: { date: '2026-10-14' } }], ctxDone),
    ).toBeUndefined();
  });

  it('weather:5 天内(含第 5 天)且未查过 → 选中', () => {
    expect(
      selectAnalyzeToolCall([{ name: 'weather', params: { date: '2026-10-13' } }], baseCtx()),
    ).toEqual({ name: 'weather', params: { date: '2026-10-13' } });
    expect(
      selectAnalyzeToolCall([{ name: 'weather', params: { date: '2026-10-18' } }], baseCtx()),
    ).toEqual({ name: 'weather', params: { date: '2026-10-18' } });
  });

  it('rag_attraction:已覆盖/已查过/空名 → 不选中;未覆盖 → 选中并 trim', () => {
    expect(
      selectAnalyzeToolCall(
        [{ name: 'rag_attraction', params: { attraction: '正定古城' } }],
        baseCtx(),
      ),
    ).toBeUndefined();

    const ctxDone = baseCtx();
    ctxDone.ragDone = new Set(['赵云庙']);
    expect(
      selectAnalyzeToolCall(
        [{ name: 'rag_attraction', params: { attraction: '赵云庙' } }],
        ctxDone,
      ),
    ).toBeUndefined();

    expect(
      selectAnalyzeToolCall(
        [{ name: 'rag_attraction', params: { attraction: '   ' } }],
        baseCtx(),
      ),
    ).toBeUndefined();

    expect(
      selectAnalyzeToolCall(
        [{ name: 'rag_attraction', params: { attraction: '  柏林禅寺  ' } }],
        baseCtx(),
      ),
    ).toEqual({ name: 'rag_attraction', params: { attraction: '柏林禅寺' } });
  });

  it('多候选时跳过非法项取第一个合法项', () => {
    expect(
      selectAnalyzeToolCall(
        [
          { name: 'weather', params: { date: '2026-10-19' } },
          { name: 'rag_attraction', params: { attraction: '正定古城' } },
          { name: 'rag_attraction', params: { attraction: '赵云庙' } },
        ],
        baseCtx(),
      ),
    ).toEqual({ name: 'rag_attraction', params: { attraction: '赵云庙' } });
  });
});
