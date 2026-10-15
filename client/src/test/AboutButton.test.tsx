import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AboutButton from '../components/AboutButton';

function mockFetchVersion(impl: () => Promise<unknown>) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}

describe('AboutButton', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初始只渲染图标按钮,弹窗关闭', () => {
    render(<AboutButton />);
    expect(screen.getByTestId('about-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument();
  });

  it('点击按钮打开弹窗,展示 agent 名称/能力/客户端版本,并请求 /api/version', async () => {
    mockFetchVersion(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ name: 'shijiazhuang-agent-server', version: '1.2.3', node: 'v20.10.0' }),
      }),
    );
    render(<AboutButton />);

    fireEvent.click(screen.getByTestId('about-btn'));

    const modal = await screen.findByTestId('about-modal');
    expect(within(modal).getByText('石家庄旅游助手')).toBeInTheDocument();
    expect(within(modal).getByText(/多日行程规划/)).toBeInTheDocument();
    expect(within(modal).getByText(new RegExp(`v${__APP_VERSION__}`))).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/version');

    // 服务端信息渲染
    expect(within(modal).getByText(/shijiazhuang-agent-server v1.2.3/)).toBeInTheDocument();
  });

  it('/api/version 失败时展示降级文案,不崩溃', async () => {
    mockFetchVersion(() => Promise.reject(new Error('network down')));
    render(<AboutButton />);

    fireEvent.click(screen.getByTestId('about-btn'));

    const modal = await screen.findByTestId('about-modal');
    expect(await within(modal).findByText(/信息不可用/)).toBeInTheDocument();
  });

  it('点关闭按钮 / 遮罩 / Esc 均可关闭弹窗', async () => {
    mockFetchVersion(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ name: 'server', version: '0.0.1', node: 'v20' }),
      }),
    );
    render(<AboutButton />);

    // 关闭按钮
    fireEvent.click(screen.getByTestId('about-btn'));
    fireEvent.click(await screen.findByTestId('about-close'));
    expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument();

    // 遮罩点击
    fireEvent.click(screen.getByTestId('about-btn'));
    fireEvent.click(await screen.findByTestId('about-backdrop'));
    expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument();

    // Esc
    fireEvent.click(screen.getByTestId('about-btn'));
    await screen.findByTestId('about-modal');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument();
  });
});
