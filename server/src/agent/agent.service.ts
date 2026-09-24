import { Injectable, Logger } from '@nestjs/common';
import {
  AgentEvents,
  AppErrorEvent,
  ChatAskPayload,
  ChatDoneEvent,
  ChatTokenEvent,
  PlanCreatePayload,
  PlanDay,
  PlanProgressEvent,
  PlanResultEvent,
  TravelPlan,
} from './agent.types';

/** 向当前连接的 client 发送事件的回调,由 Gateway 注入。 */
export type Emit = (event: string, data: unknown) => void;

/** 返回 true 表示该请求已被 client 取消,应尽快停止。 */
export type IsCancelled = () => boolean;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 石家庄及周边景点素材池(mock,后续由 RAG/LLM 替换)。 */
const SPOTS = [
  { title: '河北博物院', place: '石家庄市中心', desc: '看长信宫灯、金缕玉衣,了解燕赵文明。', tips: '免费,需提前预约,建议留 3 小时。' },
  { title: '正定古城', place: '正定县', desc: '夜游古城墙,逛隆兴寺、荣国府。', tips: '离市区约 30 分钟车程,适合半日到一日。' },
  { title: '隆兴寺', place: '正定古城内', desc: '千年古刹,倒坐观音、转轮藏堪称一绝。', tips: '与荣国府、古城墙可安排同一天。' },
  { title: '赵州桥', place: '赵县', desc: '世界现存最古老的敞肩石拱桥。', tips: '可与柏林禅寺一并游览。' },
  { title: '苍岩山', place: '井陉县', desc: '悬空寺桥楼殿,《卧虎藏龙》取景地。', tips: '山路较多,穿舒适鞋,预留一整天。' },
  { title: '嶂石岩', place: '赞皇县', desc: '国家级地貌命名地,赤壁长墙震撼。', tips: '距市区较远,建议自驾或跟团。' },
  { title: '西柏坡', place: '平山县', desc: '红色旅游圣地,新中国从这里走来。', tips: '免费开放,含纪念馆与柏坡湖。' },
  { title: '沱沱河·里运河夜游', place: '市区滹沱河畔', desc: '滨水步道散步,看城市灯光秀。', tips: '适合傍晚放松,晚餐可就近解决。' },
];

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  /** 生成行程骨架:progress 逐节点推进,最终返回 mock plan。 */
  async generatePlan(
    payload: PlanCreatePayload,
    emit: Emit,
    isCancelled: IsCancelled,
  ): Promise<void> {
    const { requestId, input } = payload;

    // 输入校验(规范:days 1-7)
    if (!input || !Number.isInteger(input.days) || input.days < 1 || input.days > 7) {
      this.emitError(emit, requestId, 'INVALID_INPUT', '行程天数需为 1-7 的整数。');
      return;
    }

    const step = async (node: PlanProgressEvent['node'], message: string, cost = 600) => {
      emit(AgentEvents.PLAN_PROGRESS, { requestId, node, status: 'start', message } as PlanProgressEvent);
      await delay(cost);
      if (isCancelled()) {
        this.emitError(emit, requestId, 'CANCELLED', '请求已取消。');
        throw new CancelledError();
      }
      emit(AgentEvents.PLAN_PROGRESS, { requestId, node, status: 'finish' } as PlanProgressEvent);
    };

    try {
      await step('retrieve', '正在检索景点资料…');
      await step('plan', `正在为你规划 ${input.days} 天行程…`);
      await step('refine', '正在优化路线与时间安排…');

      const plan = this.buildMockPlan(input.days, input.interests);
      await step('done', '行程已生成');

      emit(AgentEvents.PLAN_RESULT, { requestId, plan } as PlanResultEvent);
    } catch (err) {
      if (err instanceof CancelledError) return;
      this.logger.error(err instanceof Error ? err.stack : String(err));
      this.emitError(emit, requestId, 'INTERNAL', '生成行程时出现错误,请稍后重试。');
    }
  }

  /** 问答:mock 逐 token 流式输出,结束发 chat:done。 */
  async answerQuestion(
    payload: ChatAskPayload,
    emit: Emit,
    isCancelled: IsCancelled,
  ): Promise<void> {
    const { requestId, sessionId, question } = payload;

    if (!question || !question.trim()) {
      this.emitError(emit, requestId, 'INVALID_INPUT', '问题不能为空。');
      return;
    }

    const answer = this.buildMockAnswer(question);

    // 按字符分片模拟流式输出
    for (const token of this.tokenize(answer)) {
      if (isCancelled()) {
        this.emitError(emit, requestId, 'CANCELLED', '请求已取消。');
        return;
      }
      emit(AgentEvents.CHAT_TOKEN, { requestId, sessionId, token } as ChatTokenEvent);
      await delay(40);
    }

    emit(AgentEvents.CHAT_DONE, {
      requestId,
      sessionId,
      answer,
      sources: ['景点/正定古城.md', '景点/河北博物院.md'],
    } as ChatDoneEvent);
  }

  // ---------- mock 数据构造 ----------

  private buildMockPlan(days: number, interests?: string[]): TravelPlan {
    const planDays: PlanDay[] = [];
    for (let d = 0; d < days; d++) {
      const morning = SPOTS[(d * 2) % SPOTS.length];
      const afternoon = SPOTS[(d * 2 + 1) % SPOTS.length];
      planDays.push({
        day: d + 1,
        items: [
          { time: '09:00', title: morning.title, place: morning.place, description: morning.desc, tips: morning.tips },
          { time: '14:00', title: afternoon.title, place: afternoon.place, description: afternoon.desc, tips: afternoon.tips },
          { time: '18:30', title: '自由活动 / 品尝本地美食', place: '市区', description: '推荐试试牛肉板面、正定八大碗。' },
        ],
      });
    }

    return {
      title: `石家庄 ${days} 日休闲游`,
      days: planDays,
      summary: interests?.length
        ? `结合你的兴趣(${interests.join('、')})安排的市内 + 周边组合路线。`
        : '兼顾市区人文与周边山水的经典组合路线。',
      tips: [
        '市内地铁 + 公交可达主要景点,周边建议自驾或包车。',
        '春秋季最适合出游,夏季注意山区防晒防雨。',
        '(此为 mock 数据,接入 LLM/RAG 后将由模型实时生成)',
      ],
    };
  }

  private buildMockAnswer(question: string): string {
    return (
      `关于「${question.trim()}」:石家庄是一座被低估的宝藏城市。` +
      '市区可以逛河北博物院、正定古城,感受燕赵底蕴;' +
      '周边有苍岩山、嶂石岩、西柏坡,山水与红色旅游兼备。' +
      '如果你告诉我出行天数和兴趣,我可以帮你排一份详细行程。' +
      '(此为 mock 回答,接入 LLM/RAG 后将由模型实时生成)'
    );
  }

  /** 简单分词:中文按标点/空格切,保证流式观感自然。 */
  private tokenize(text: string): string[] {
    return text.match(/[^，。；：、！？\s]+[，。；：、！？]?|\s+/g) ?? [text];
  }

  private emitError(emit: Emit, requestId: string, code: AppErrorEvent['code'], message: string): void {
    emit(AgentEvents.APP_ERROR, { requestId, code, message } as AppErrorEvent);
  }
}

class CancelledError extends Error {}
