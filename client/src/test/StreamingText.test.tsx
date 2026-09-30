import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StreamingText from '../components/StreamingText';

describe('StreamingText', () => {
  it('renders text content', () => {
    render(<StreamingText text="你好" />);
    expect(screen.getByText(/你好/)).toBeInTheDocument();
  });

  it('renders a blinking cursor span', () => {
    const { container } = render(<StreamingText text="" />);
    const cursor = container.querySelector('span.animate-blink');
    expect(cursor).not.toBeNull();
  });

  it('renders markdown while streaming', () => {
    render(<StreamingText text="**加粗**" />);
    expect(screen.getByText('加粗').tagName).toBe('STRONG');
  });

  it('drops leading blank lines', () => {
    const { container } = render(<StreamingText text={'\n\n第一行'} />);
    expect(container.querySelector('p')?.textContent).toBe('第一行');
  });
});
