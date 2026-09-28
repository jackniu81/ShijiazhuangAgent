import { PlanDay, TravelPlan } from '@shijiazhuang-agent/shared';
import { validatePlanJson } from './plan.schema';

/**
 * 校验器的边界在此锁定:类型错必须拦(交节点回炉),可规整的小漂移放行
 * (交 refinePlan 兜底),避免把"能不能要"和"要不要补"混在一层。
 */
describe('validatePlanJson', () => {
  const good = JSON.stringify({
    title: '石家庄 2 日游',
    days: [
      { day: 1, items: [{ time: '09:00', title: '河北博物院' }] },
      { day: 2, items: [{ title: '正定古城' }] },
    ],
    summary: '人文 + 古城',
    tips: ['早出门'],
  });

  it('合法 JSON → 通过,保留天数顺序', () => {
    const r = validatePlanJson(good, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.days.map((d) => d.day)).toEqual([1, 2]);
  });

  it('markdown 代码块包裹 → 剥壳后通过', () => {
    expect(validatePlanJson('```json\n' + good + '\n```', 2).ok).toBe(true);
  });

  it('前后夹杂解释文字 → 提取花括号内容后通过', () => {
    expect(validatePlanJson('好的,行程如下:' + good + ' 祝旅途愉快', 2).ok).toBe(true);
  });

  it('可选字段缺失 → 通过(交 refinePlan 补默认)', () => {
    expect(validatePlanJson('{"days":[{"items":[{"title":"河北博物院"}]}]}', 1).ok).toBe(true);
  });

  it('day 写成字符串 → 收编为数值后通过', () => {
    const r = validatePlanJson(good.replace('"day": 1', '"day": "1"'), 2);
    expect(r.ok).toBe(true);
  });

  it('可选字段为 null → 视为未提供并通过', () => {
    const r = validatePlanJson(good.replace('"人文 + 古城"', 'null'), 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.summary).toBeUndefined();
  });

  it('完全不是 JSON → 失败并给出可读原因', () => {
    const r = validatePlanJson('抱歉,我无法规划行程。', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain('不是合法 JSON');
  });

  it('days 为空数组 → 失败', () => {
    expect(validatePlanJson('{"title":"x","days":[]}', 2).ok).toBe(false);
  });

  it('days 不是数组 → 失败', () => {
    const r = validatePlanJson('{"days":{"day":1}}', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain('days');
  });

  it('某日 items 为空 → 失败', () => {
    expect(validatePlanJson('{"days":[{"day":1,"items":[]}]}', 1).ok).toBe(false);
  });

  it('安排项缺标题 → 失败并定位到具体路径', () => {
    const r = validatePlanJson('{"days":[{"items":[{"time":"09:00"}]}]}', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons[0]).toContain('days.0.items.0.title');
      expect(r.reasons[0]).toContain('应为非空字符串');
    }
  });

  it('标题为空串 → 失败并提示缺少标题', () => {
    const r = validatePlanJson('{"days":[{"items":[{"title":"  "}]}]}', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain('缺少标题');
  });

  it('天数超出需求 → 失败并提示按需求天数重出', () => {
    const r = validatePlanJson(good, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain('请按 1 天');
  });

  it('天数不足需求 → 放行(补齐是 refine 的职责)', () => {
    expect(validatePlanJson('{"days":[{"items":[{"title":"河北博物院"}]}]}', 3).ok).toBe(true);
  });

  it('模型多塞的字段被丢弃,不污染 TravelPlan', () => {
    const r = validatePlanJson(
      '{"days":[{"items":[{"title":"隆兴寺","weather":"晴","score":9}]}]}',
      1,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const item = r.plan.days[0].items[0] as unknown as Record<string, unknown>;
      expect(item.weather).toBeUndefined();
      expect(item.score).toBeUndefined();
    }
  });

  it('失败时回传原始输出,供回炉 prompt 节选引用', () => {
    const r = validatePlanJson('这是一段脏输出', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe('这是一段脏输出');
  });

  it('通过结果可直接作为 TravelPlan 消费(类型锚点)', () => {
    const r = validatePlanJson(good, 2);
    if (!r.ok) throw new Error('用例数据应通过校验');
    const plan: TravelPlan = r.plan;
    const days: PlanDay[] = plan.days;
    expect(days).toHaveLength(2);
  });
});
