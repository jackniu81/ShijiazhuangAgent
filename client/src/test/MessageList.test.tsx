import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MessageList from '../components/MessageList';
import type { ChatMessage } from '../lib/types';

describe('MessageList', () => {
  it('shows welcome when empty', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText('石家庄旅游助手 🤖')).toBeInTheDocument();
  });

  it('renders all messages', () => {
    const msgs: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() },
      { id: 'a1', role: 'assistant', kind: 'text', content: 'yo', timestamp: Date.now() },
    ];
    render(<MessageList messages={msgs} />);
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('yo')).toBeInTheDocument();
  });

  it('marks the streaming message', () => {
    const msgs: ChatMessage[] = [
      { id: 'a1', role: 'assistant', kind: 'text', content: 'streaming now', timestamp: Date.now() },
    ];
    const { container } = render(
      <MessageList messages={msgs} streamingId="a1" />
    );
    // streaming message should render StreamingText (contains animate-blink cursor)
    expect(container.querySelector('span.animate-blink')).not.toBeNull();
  });
});
