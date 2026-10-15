import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const { agentSocket, emitState } = vi.hoisted(() => {
  const stateListeners = new Set<(connected: boolean, err?: string) => void>();
  const socket = {
    connected: false,
    connect: vi.fn(),
    onConnectionChange: vi.fn((cb: (connected: boolean, err?: string) => void) =>
      stateListeners.add(cb),
    ),
    offConnectionChange: vi.fn((cb: (connected: boolean, err?: string) => void) =>
      stateListeners.delete(cb),
    ),
  };
  return {
    agentSocket: socket,
    emitState(connected: boolean, err?: string) {
      socket.connected = connected;
      stateListeners.forEach((cb) => cb(connected, err));
    },
  };
});

vi.mock('../lib/socket', () => ({ agentSocket }));

import ConnectionStatus from '../components/ConnectionStatus';

describe('ConnectionStatus', () => {
  beforeEach(() => {
    agentSocket.connected = false;
  });

  it('默认展示"未连接"(红点)', () => {
    render(<ConnectionStatus />);
    expect(screen.getByText('未连接')).toBeInTheDocument();
    expect(screen.getByLabelText('未连接')).toBeInTheDocument();
    expect(agentSocket.connect).toHaveBeenCalled();
  });

  it('连接成功后展示"已连接"', () => {
    render(<ConnectionStatus />);
    act(() => emitState(true));
    expect(screen.getByText('已连接')).toBeInTheDocument();
  });

  it('握手被拒时展示"未授权",title 显示原因', () => {
    render(<ConnectionStatus />);
    act(() => emitState(false, 'unauthorized'));
    expect(screen.getByText('未授权')).toBeInTheDocument();
    expect(screen.getByTitle('unauthorized')).toBeInTheDocument();
  });

  it('断开后回到"未连接"', () => {
    render(<ConnectionStatus />);
    act(() => emitState(true));
    act(() => emitState(false));
    expect(screen.getByText('未连接')).toBeInTheDocument();
  });
});
