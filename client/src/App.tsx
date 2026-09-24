import { useMemo, useState } from 'react';
import Layout from './components/Layout';
import MessageList from './components/MessageList';
import type { ChatMessage, TravelPlan } from './lib/types';

// ---- Mock 数据:覆盖 user / assistant:text / assistant:plan / system / streaming ----
const MOCK_PLAN: TravelPlan = {
  title: '石家庄 2 日周末游',
  summary:
    '经典古城 + 红色圣地组合,两天轻松行程,适合亲子或历史爱好者。',
  days: [
    {
      day: 1,
      items: [
        {
          time: '09:00',
          title: '正定古城',
          place: '石家庄市正定县',
          description: '千年古城墙 + 隆兴寺,可登上城墙远眺。',
          tips: '建议从南门进入,免费。',
        },
        {
          time: '12:30',
          title: '午餐:正定八大碗',
          place: '正定镇',
          description: '河北传统菜,荤菜为主,分量足。',
        },
        {
          time: '14:30',
          title: '荣国府',
          place: '正定兴荣路',
          description: '《红楼梦》拍摄基地,园林式仿古建筑。',
          tips: '门票约 40 元。',
        },
      ],
    },
    {
      day: 2,
      items: [
        {
          time: '08:30',
          title: '西柏坡纪念馆',
          place: '平山县西柏坡村',
          description: '红色教育基地,免费参观(需预约)。',
          tips: '距市区约 90km,建议包车或跟团。',
        },
        {
          time: '16:00',
          title: '返回石家庄 + 晚餐',
          place: '市区',
          description: '可在勒泰中心吃晚饭,结束行程。',
        },
      ],
    },
  ],
  tips: [
    '9-11 月气候最舒适,春有沙尘暴,夏多雨。',
    '石家庄地铁覆盖主要景点,办一张交通卡更方便。',
    '西柏坡建议预留 4-5 小时,往返车程约 3 小时。',
  ],
};

const now = Date.now();

const STATIC_MESSAGES: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content: '帮我规划一个 2 天的周末游',
    timestamp: now - 1000 * 60 * 5,
  },
  {
    id: 's1',
    role: 'system',
    type: 'progress',
    content: '🔍 正在检索景点资料…',
    timestamp: now - 1000 * 60 * 4 + 1000,
  },
  {
    id: 's2',
    role: 'system',
    type: 'progress',
    content: '🧠 正在生成行程…',
    timestamp: now - 1000 * 60 * 4 + 4000,
  },
  {
    id: 'a-plan',
    role: 'assistant',
    kind: 'plan',
    plan: MOCK_PLAN,
    timestamp: now - 1000 * 60 * 4 + 8000,
  },
  {
    id: 'u2',
    role: 'user',
    content: '正定古城要门票吗?',
    timestamp: now - 1000 * 60,
  },
];

// 流式 token 模拟
const STREAM_TOKENS = [
  '正定古城墙',
  ' 免费',
  ' 开放',
  ',',
  ' 但',
  ' 隆兴寺',
  ' 需要',
  ' 门票',
  '(',
  '约',
  '50',
  '元',
  ')。',
  ' 建议',
  ' 上午',
  '8',
  '点前',
  ' 到,',
  ' 人',
  '少',
  ' 好',
  ' 拍',
  '照。',
];

const STREAM_ID = 'a-stream';

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(STATIC_MESSAGES);
  const [isStreaming, setIsStreaming] = useState(false);

  const streamingId = useMemo(
    () => (isStreaming ? STREAM_ID : undefined),
    [isStreaming]
  );

  const startStreamingDemo = () => {
    if (isStreaming) return;
    setIsStreaming(true);
    setMessages((prev) => [
      ...prev,
      {
        id: STREAM_ID,
        role: 'assistant',
        kind: 'text',
        content: '',
        timestamp: Date.now(),
      },
    ]);

    let i = 0;
    const timer = setInterval(() => {
      const token = STREAM_TOKENS[i++];
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.id === STREAM_ID &&
            m.role === 'assistant' &&
            m.kind === 'text'
          ) {
            return { ...m, content: m.content + token };
          }
          return m;
        })
      );
      if (i >= STREAM_TOKENS.length) {
        clearInterval(timer);
        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((m) => {
            if (
              m.id === STREAM_ID &&
              m.role === 'assistant' &&
              m.kind === 'text'
            ) {
              return {
                ...m,
                sources: ['景点/正定古城.md', '景点/隆兴寺.md'],
              };
            }
            return m;
          })
        );
      }
    }, 200);
  };

  return (
    <Layout>
      {/* Demo controls — 仅 Step 12 期间展示,ChatWindow 落地后移除 */}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <button
          onClick={startStreamingDemo}
          disabled={isStreaming}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isStreaming ? '流式输出中…' : '▶ 演示打字机效果'}
        </button>
        <button
          onClick={() => {
            setIsStreaming(false);
            setMessages(STATIC_MESSAGES);
          }}
          className="rounded-md bg-slate-100 px-3 py-1.5 text-slate-600 shadow-sm transition hover:bg-slate-200"
        >
          ↺ 重置
        </button>
        <span className="self-center text-slate-400">
          Step 12 — 消息渲染组件 Demo
        </span>
      </div>

      <div className="h-[60vh] min-h-[420px]">
        <MessageList messages={messages} streamingId={streamingId} />
      </div>
    </Layout>
  );
}
