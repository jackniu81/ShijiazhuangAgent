import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// 用可控制的 socket 桩模拟连接状态,避免测试发起真实 WebSocket
const { socketMock, listeners } = vi.hoisted(() => {
  const listeners = new Set<(c: boolean, err?: string) => void>();
  const socketMock = {
    connected: false,
    connect: vi.fn(),
    onConnectionChange: vi.fn((cb: (c: boolean, err?: string) => void) => listeners.add(cb)),
    offConnectionChange: vi.fn((cb: (c: boolean, err?: string) => void) => listeners.delete(cb)),
  };
  return { socketMock, listeners };
});

vi.mock('../lib/socket', () => ({ agentSocket: socketMock }));

import ConnectionStatus from '../components/ConnectionStatus';

function setConnected(c: boolean, err = '') {
  socketMock.connected = c;
  listeners.forEach((cb) => cb(c, err));
}

describe('ConnectionStatus', () => {
  beforeEach(() => {
    listeners.clear();
    socketMock.connected = false;
    socketMock.connect.mockClear();
  });

  it('未连接时渲染可点击按钮,点击弹出失败原因对话框', async () => {
    render(<ConnectionStatus />);
    setConnected(false, 'handshake unauthorized: invalid token');

    const btn = screen.getByTestId('conn-status-btn');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);

    const modal = await screen.findByTestId('conn-error-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId('conn-error-reason').textContent).toContain('invalid token');
    expect(screen.getByText('未授权')).toBeInTheDocument();

    // 关闭按钮可关闭
    fireEvent.click(screen.getByTestId('conn-error-close'));
    expect(screen.queryByTestId('conn-error-modal')).not.toBeInTheDocument();
  });

  it('未连接且无错误原因时,展示服务不可达的通用说明(不显示原始错误块)', () => {
    render(<ConnectionStatus />);
    setConnected(false, '');

    fireEvent.click(screen.getByTestId('conn-status-btn'));
    expect(screen.getByText(/无法连接到服务器/)).toBeInTheDocument();
    expect(screen.queryByTestId('conn-error-reason')).not.toBeInTheDocument();
  });

  it('已连接时不渲染按钮,恢复连接后弹窗自动关闭', async () => {
    render(<ConnectionStatus />);
    setConnected(false, 'boom');
    fireEvent.click(screen.getByTestId('conn-status-btn'));
    expect(await screen.findByTestId('conn-error-modal')).toBeInTheDocument();

    // socket 状态恢复
    setConnected(true);
    expect(screen.queryByTestId('conn-status-btn')).not.toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.queryByTestId('conn-error-modal')).not.toBeInTheDocument();
  });

  it('遮罩点击与 Esc 关闭弹窗', async () => {
    render(<ConnectionStatus />);
    setConnected(false, 'boom');

    fireEvent.click(screen.getByTestId('conn-status-btn'));
    fireEvent.click(await screen.findByTestId('conn-error-backdrop'));
    expect(screen.queryByTestId('conn-error-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('conn-status-btn'));
    await screen.findByTestId('conn-error-modal');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('conn-error-modal')).not.toBeInTheDocument();
  });
});
