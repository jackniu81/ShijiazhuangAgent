import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MessageItem from '../components/MessageItem';
import type { ChatMessage, TravelPlan } from '../lib/types';

const PLAN: TravelPlan = {
  title: '石家庄 2 日游',
  days: [
    {
      day: 1,
      items: [
        { time: '09:00', title: '正定古城', place: '正定县' },
      ],
    },
  ],
  tips: ['9-11 月最舒适'],
};

const t = Date.now();

describe('MessageItem', () => {
  it('renders user message on the right', () => {
    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '帮我规划一下',
      timestamp: t,
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('帮我规划一下')).toBeInTheDocument();
    expect(screen.getByText('你')).toBeInTheDocument();
  });

  it('renders assistant text with sources', () => {
    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      kind: 'text',
      content: '正定古城免费',
      sources: ['景点/正定古城.md'],
      timestamp: t,
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('正定古城免费')).toBeInTheDocument();
    expect(screen.getByText(/📎 景点\/正定古城\.md/)).toBeInTheDocument();
  });

  it('renders cancelled assistant with strikethrough', () => {
    const msg: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      kind: 'text',
      content: '没说完的话',
      cancelled: true,
      timestamp: t,
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText(/已停止/)).toBeInTheDocument();
  });

  it('renders plan card', () => {
    const msg: ChatMessage = {
      id: 'a3',
      role: 'assistant',
      kind: 'plan',
      plan: PLAN,
      timestamp: t,
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('石家庄 2 日游')).toBeInTheDocument();
    expect(screen.getByText('正定古城')).toBeInTheDocument();
    expect(screen.getByText(/9-11 月最舒适/)).toBeInTheDocument();
  });

  it('renders progress system message', () => {
    const msg: ChatMessage = {
      id: 's1',
      role: 'system',
      type: 'progress',
      content: '🔍 正在检索…',
      timestamp: t,
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText('🔍 正在检索…')).toBeInTheDocument();
  });

  it('renders error system message with ⚠️', () => {
    const msg: ChatMessage = {
      id: 's2',
      role: 'system',
      type: 'error',
      content: '服务暂不可用',
      timestamp: t,
    };
    render(<MessageItem message={msg} />);
    expect(screen.getByText(/⚠️.*服务暂不可用/)).toBeInTheDocument();
  });
});
