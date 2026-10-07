import { extractTripDate, lookupWeather, WEATHER_MOCK_NOTE } from './weather.tool';

/** 2026-10-07 是星期三,作为所有相对日期断言的基准。 */
const WED = new Date(2026, 9, 7);

const dateOf = (q: string): string | null => extractTripDate(q, WED)?.date ?? null;

describe('extractTripDate 相对日期', () => {
  it('今天/明天/后天/大后天按偏移取日', () => {
    expect(dateOf('今天去正定合适吗')).toBe('2026-10-07');
    expect(dateOf('明天去正定合适吗')).toBe('2026-10-08');
    expect(dateOf('后天去正定合适吗')).toBe('2026-10-09');
    // "大后天"不能被"后天"抢先命中
    expect(dateOf('大后天去苍岩山')).toBe('2026-10-10');
  });

  it('N天后支持阿拉伯与中文数字', () => {
    expect(dateOf('3天后人多吗')).toBe('2026-10-10');
    expect(dateOf('两天后再去')).toBe('2026-10-09');
    expect(dateOf('十天后')).toBe('2026-10-17');
  });

  it('label 返回命中原文,便于日志核对', () => {
    expect(extractTripDate('下周六去嶂石岩', WED)?.label).toBe('下周六');
  });
});

describe('extractTripDate 星期', () => {
  it('周五取本周剩余的那天', () => {
    expect(dateOf('周五去正定')).toBe('2026-10-09');
    expect(dateOf('星期一去河北博物院')).toBe('2026-10-12');
    expect(dateOf('礼拜天')).toBe('2026-10-11');
  });

  it('下周六顺延到下一周的那个星期六', () => {
    expect(dateOf('下周六去苍岩山')).toBe('2026-10-17');
  });

  it('裸"周X"当天已是该星期时按下周理解', () => {
    // 基准日为周三
    expect(dateOf('周三去正定')).toBe('2026-10-14');
  });
});

describe('extractTripDate 绝对日期', () => {
  it('X月X日按今年取,已过则顺延到明年', () => {
    expect(dateOf('10月15日门票多少')).toBe('2026-10-15');
    expect(dateOf('3月5号去公园')).toBe('2027-03-05');
  });

  it('带年份的写法直接取该日', () => {
    expect(dateOf('2026年12月1日')).toBe('2026-12-01');
    expect(dateOf('2026-11-11 去正定')).toBe('2026-11-11');
  });

  it('过去的日期不作出行参考', () => {
    expect(dateOf('2025年1月1日天气如何')).toBeNull();
  });
});

describe('extractTripDate 无具体时间', () => {
  it.each(['正定古城好玩吗', '夏天去合适吗', '国庆人多不多', '门票多少钱', ''])('%s → null', (q) => {
    expect(extractTripDate(q, WED)).toBeNull();
  });
});

describe('lookupWeather(mock 数据源)', () => {
  it('同一日期结果确定,便于复现与测试', () => {
    expect(lookupWeather('2026-10-15')).toBe(lookupWeather('2026-10-15'));
  });

  it('文本含城市、日期、气温并如实标注模拟数据', () => {
    const text = lookupWeather('2026-10-15');
    expect(text).toContain('2026年10月15日');
    expect(text).toContain('石家庄');
    expect(text).toContain('℃');
    expect(text).toContain(WEATHER_MOCK_NOTE);
  });

  it('气温随季节变化:盛夏高于隆冬,且 low<high 落在合理区间', () => {
    const temps = (d: string): [number, number] => {
      const m = lookupWeather(d).match(/(-?\d+)~(-?\d+)℃/);
      return [Number(m?.[1]), Number(m?.[2])];
    };
    const summer = temps('2026-07-20');
    const winter = temps('2026-01-20');
    expect(summer[0]).toBeLessThan(summer[1]);
    expect(winter[0]).toBeLessThan(winter[1]);
    expect(summer[1]).toBeGreaterThan(winter[1]);
    for (const t of [...summer, ...winter]) {
      expect(t).toBeGreaterThanOrEqual(-15);
      expect(t).toBeLessThanOrEqual(40);
    }
  });

  it('雨天给出带伞建议', () => {
    // 扫一批日期,命中雨天时必须带建议,避免只报数字
    const rainy = ['2026-06-05', '2026-06-12', '2026-07-03', '2026-08-19', '2026-09-02']
      .map(lookupWeather)
      .filter((t) => t.includes('雨'));
    for (const t of rainy) expect(t).toContain('带伞');
  });
});
