import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

const { agentSocket, emitState, emitEvent } = vi.hoisted(() => {
  const stateListeners = new Set<(connected: boolean, err?: string) => void>();
  const handlers = new Map<string, Set<(data: any) => void>>();
  const socket = {
    connected: false,
    connect: vi.fn(),
    on: vi.fn((ev: string, cb: (data: any) => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(cb);
    }),
    off: vi.fn((ev: string, cb: (data: any) => void) => {
      handlers.get(ev)?.delete(cb);
    }),
    onConnectionChange: vi.fn((cb: (connected: boolean, err?: string) => void) =>
      stateListeners.add(cb),
    ),
    offConnectionChange: vi.fn((cb: (connected: boolean, err?: string) => void) =>
      stateListeners.delete(cb),
    ),
    ask: vi.fn(),
    createPlan: vi.fn(),
    cancel: vi.fn(),
  };
  return {
    agentSocket: socket,
    emitState(connected: boolean, err = '') {
      socket.connected = connected;
      stateListeners.forEach((cb) => cb(connected, err));
    },
    emitEvent(ev: string, data: any) {
      handlers.get(ev)?.forEach((cb) => cb(data));
    },
  };
});

vi.mock('../lib/socket', () => ({ agentSocket }));

import ChatWindow from '../components/ChatWindow';
import { AgentEvents } from '../lib/types';

function connect() {
  act(() => emitState(true));
}

describe('ChatWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentSocket.connected = false;
  });

  it('初始渲染输入区,未连接时输入/发送均禁用', () => {
    render(<ChatWindow />);
    expect(screen.getByTestId('chat-input')).toBeDisabled();
    expect(screen.getByTestId('send-btn')).toBeDisabled();
    expect(screen.queryByTestId('stop-btn')).not.toBeInTheDocument();
    expect(agentSocket.connect).toHaveBeenCalled();
  });

  it('连接后可输入并发送,ask 携带问题文本,进入流式状态显示停止按钮', () => {
    render(<ChatWindow />);
    connect();

    const input = screen.getByTestId('chat-input');
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: '怎么去正定' } });
    fireEvent.click(screen.getByTestId('send-btn'));

    expect(agentSocket.ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: '怎么去正定' }),
    );
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('stop-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('send-btn')).not.toBeInTheDocument();
  });

  it('空输入不发送', () => {
    render(<ChatWindow />);
    connect();
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(agentSocket.ask).not.toHaveBeenCalled();
  });

  it('Enter 发送,Shift+Enter 不发送', () => {
    render(<ChatWindow />);
    connect();
    const input = screen.getByTestId('chat-input');

    fireEvent.change(input, { target: { value: '驼梁一日游' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(agentSocket.ask).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(agentSocket.ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: '驼梁一日游' }),
    );
  });

  it('点击停止按钮以当前 requestId 调用 cancel', () => {
    render(<ChatWindow />);
    connect();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '测试' } });
    fireEvent.click(screen.getByTestId('send-btn'));

    const requestId = (agentSocket.ask.mock.calls[0][0] as { requestId: string }).requestId;
    fireEvent.click(screen.getByTestId('stop-btn'));
    expect(agentSocket.cancel).toHaveBeenCalledWith(requestId);
  });

  it('chat_done 事件后退出流式,恢复发送按钮', () => {
    render(<ChatWindow />);
    connect();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '测试' } });
    fireEvent.click(screen.getByTestId('send-btn'));

    const requestId = (agentSocket.ask.mock.calls[0][0] as { requestId: string }).requestId;
    act(() => emitEvent(AgentEvents.CHAT_DONE, { requestId }));
    expect(screen.queryByTestId('stop-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-btn')).toBeInTheDocument();
  });

  it('"规划行程"按钮切换 PlanningForm 显隐', () => {
    render(<ChatWindow />);
    connect();
    const toggle = screen.getByRole('button', { name: '📋 规划行程' });

    expect(screen.queryByTestId('days')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId('days')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '📋 规划行程' }));
    expect(screen.queryByTestId('days')).not.toBeInTheDocument();
  });

  it('消息区随渲染出现(经 Layout + MessageList)', () => {
    const { container } = render(<ChatWindow />);
    expect(within(container as HTMLElement).getByText('石家庄旅游助手')).toBeInTheDocument();
  });
});
