/**
 * Mock 天气数据源(chat-tools-spec P3):无外部依赖,随机生成天气文案。
 * 不接入真实天气 API(P5 取消),此实现即为正式数据源。
 */

interface Forecast {
  cond: string;
  low: number;
  high: number;
  tip: string;
}

const FORECASTS: readonly Forecast[] = [
  { cond: '晴', low: 16, high: 28, tip: '紫外线较强,注意防晒补水。' },
  { cond: '多云', low: 15, high: 26, tip: '云量较多,体感舒适,适合户外游览。' },
  { cond: '阴', low: 14, high: 23, tip: '早晚偏凉,建议带件薄外套。' },
  { cond: '小雨', low: 13, high: 21, tip: '有降雨,出门请带伞,山区注意防滑。' },
];

export function mockWeather(date: string, city = '石家庄'): Promise<string> {
  const f = FORECASTS[Math.floor(Math.random() * FORECASTS.length)];
  return Promise.resolve(`${city} ${date} ${f.cond},气温 ${f.low}~${f.high}℃。${f.tip}`);
}
