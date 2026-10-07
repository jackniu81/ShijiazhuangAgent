/**
 * 天气 tool(仅 chat 图使用):从问题里识别具体出行日期,取该日天气文本,
 * 作为参考资料注入 prompt。当前数据源是**本地 mock**(确定性、离线可用),
 * 接真实接口时只替换 `lookupWeather` 实现,`extractTripDate` 与调用方不动。
 */

/** 识别到的出行日期。date 为 YYYY-MM-DD,label 为命中的原文(便于日志核对)。 */
export interface TripDate {
  date: string;
  label: string;
}

/** mock 数据必须如实标注,避免模型把模拟值当实时预报陈述给用户。 */
export const WEATHER_MOCK_NOTE = '本地模拟数据,非实时预报';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 相对日偏移。长词在前,避免"大后天"被"后天"抢先命中。 */
const RELATIVE: Array<[RegExp, number]> = [
  [/大后天/, 3],
  [/后天|后日/, 2],
  [/明天|明日/, 1],
  [/今天|今日/, 0],
];

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** 星期序号:日/天/7 → 0,一 → 1 …六 → 6。不复用 CN_NUM,避免"两"错位。 */
const WEEKDAY_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

function weekdayIndex(token: string): number {
  if (token in WEEKDAY_NUM) return WEEKDAY_NUM[token];
  return Number(token) % 7; // '1'..'6' 原值,'7' → 0
}

/**
 * 从问题中抽取具体日期:今天/明天/后天/大后天、N天后(支持中文数字)、
 * 周X/星期X/礼拜X(可带本周/下周)、X月X日、YYYY年X月X日、YYYY-MM-DD。
 * 识别不到、或日期早于今天(过去的天气无从作为出行参考)返回 null。
 */
export function extractTripDate(question: string, now: Date = new Date()): TripDate | null {
  if (!question) return null;
  const today = atMidnight(now);

  for (const [re, offset] of RELATIVE) {
    const m = question.match(re);
    if (m) return { date: formatDate(addDays(today, offset)), label: m[0] };
  }

  const nd = question.match(/(\d+|[一二两三四五六七八九十])\s*(?:天|日)后/);
  if (nd) {
    const n = /^\d+$/.test(nd[1]) ? Number(nd[1]) : CN_NUM[nd[1]];
    if (Number.isFinite(n) && n > 0) {
      return { date: formatDate(addDays(today, n)), label: nd[0] };
    }
  }

  const week = question.match(/(本|下|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])/);
  if (week) {
    const target = weekdayIndex(week[2]);
    const ahead = (target - today.getDay() + 7) % 7;
    // "下X"固定顺延一周;"本周X"/裸"周X"若今天就是该星期,按下周理解更贴近出行提问
    const days = week[1] === '下' ? ahead + 7 : ahead === 0 ? 7 : ahead;
    return { date: formatDate(addDays(today, days)), label: week[0] };
  }

  const full = question.match(/(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*[日号]?/);
  if (full) return fromParts(Number(full[1]), Number(full[2]), Number(full[3]), full[0], today);

  // 不带年份:X月X日,按今年取;今年已过则顺延到明年(如 10 月问"3 月 5 日"多半指明年)
  const md = question.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (md) {
    const candidate = new Date(today.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    if (candidate < today) candidate.setFullYear(candidate.getFullYear() + 1);
    return { date: formatDate(candidate), label: md[0] };
  }

  return null;
}

/** 显式年月日:合法且不早于今天才算未来出行参考。 */
function fromParts(
  year: number,
  month: number,
  day: number,
  label: string,
  today: Date,
): TripDate | null {
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return null;
  if (d < today) return null;
  return { date: formatDate(d), label };
}

/** 该日天气文本(mock)。date 为 YYYY-MM-DD。 */
export function lookupWeather(date: string): string {
  const [y, m, day] = date.split('-').map(Number);
  const h = hash(date);
  const cond = pick(conditionByMonth(m), h >> 3);
  const [baseLow, baseHigh] = monthRange(m);
  // 同月内让气温有小幅起伏,避免整月一字不差
  const shift = (h >> 1) % 3;
  const low = baseLow - shift;
  const high = baseHigh - shift;
  const wind = 1 + (h % 4);
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00`).getDay()];
  const advice = travelAdvice(cond, high, low, m);

  return (
    `${y}年${m}月${day}日(周${weekday})石家庄:${cond},${low}~${high}℃,${wind}级风` +
    `${advice};${WEATHER_MOCK_NOTE}`
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pick<T>(list: T[], seed: number): T {
  return list[seed % list.length];
}

/** 石家庄各月气候区间[最低, 最高]。 */
function monthRange(month: number): [number, number] {
  const table: Array<[number, number]> = [
    [-3, 5], [1, 10], [7, 17], [13, 24], [18, 29], [22, 33],
    [24, 32], [23, 31], [18, 27], [11, 21], [4, 12], [-2, 6],
  ];
  return table[Math.min(11, Math.max(0, month - 1))];
}

function conditionByMonth(month: number): string[] {
  if (month <= 2 || month === 12) return ['晴', '多云', '阴', '小雪', '霾'];
  if (month <= 5) return ['晴', '多云', '小雨', '扬沙'];
  if (month <= 8) return ['晴', '多云', '雷阵雨', '中雨'];
  return ['晴', '多云', '小雨', '阴'];
}

function travelAdvice(cond: string, high: number, low: number, month: number): string {
  const parts: string[] = [];
  if (cond.includes('雨')) parts.push('带伞');
  if (cond === '小雪') parts.push('山区路面易结冰,出行留足时间');
  if (cond === '霾') parts.push('敏感人群减少户外时长');
  if (month >= 6 && month <= 8 && high >= 30) parts.push('午后防晒补水');
  if (high - low >= 10) parts.push('早晚温差大,备薄外套');
  return parts.length ? `;${parts.join(';')}` : '';
}
