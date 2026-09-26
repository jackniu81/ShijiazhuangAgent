/**
 * WebSocket API 契约类型 —— 唯一来源在 packages/shared(issue #48),此处 re-export
 * 保持组件既有 import 路径;Client 侧 UI 消息模型(ChatMessage)仍留在本文件。
 */
export {
  AgentEvents,
} from '@shijiazhuang-agent/shared';
export type {
  AppErrorCode,
  AppErrorEvent,
  ChatAskPayload,
  ChatDoneEvent,
  ChatTokenEvent,
  NodeStatus,
  PlanCreatePayload,
  PlanDay,
  PlanDayEvent,
  PlanItem,
  PlanNode,
  PlanProgressEvent,
  PlanResultEvent,
  TaskCancelPayload,
  TravelPlan,
} from '@shijiazhuang-agent/shared';

import type { TravelPlan } from '@shijiazhuang-agent/shared';

// ---------- Client 侧 UI 消息模型 ----------
export type ChatMessage =
  | {
      id: string;
      role: 'user';
      content: string;
      timestamp: number;
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'text';
      content: string;
      sources?: string[];
      cancelled?: boolean;
      timestamp: number;
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'plan';
      plan: TravelPlan;
      /** 流式构建中,前端显示占位天数 */
      streaming?: boolean;
      timestamp: number;
    }
  | {
      id: string;
      role: 'system';
      type: 'progress' | 'error';
      content: string;
      timestamp: number;
    };
