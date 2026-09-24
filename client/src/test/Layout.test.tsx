import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Layout from '../components/Layout';

// ConnectionStatus 会触发真实 socket 连接,测试里打桩即可
vi.mock('../components/ConnectionStatus', () => ({
  default: () => <span>mock-status</span>,
}));

describe('Layout', () => {
  it('header is sticky at top with z-index (issue #40)', () => {
    const { container } = render(
      <Layout>
        <div>content</div>
      </Layout>,
    );
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('sticky');
    expect(header!.className).toContain('top-0');
    expect(header!.className).toContain('z-10');
    // 不透明背景,滚动内容不穿帮
    expect(header!.className).toContain('bg-white');
  });

  it('renders title, children and default footer', () => {
    render(
      <Layout>
        <div>child body</div>
      </Layout>,
    );
    expect(screen.getByText('石家庄旅游助手')).toBeInTheDocument();
    expect(screen.getByText('child body')).toBeInTheDocument();
    expect(screen.getByText(/石家庄旅游助手 · v/)).toBeInTheDocument();
  });
});
