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

  it('supports whitespace-pre-wrap for multi-line streaming', () => {
    const { container } = render(<StreamingText text="第一行\n第二行" />);
    expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull();
  });
});
