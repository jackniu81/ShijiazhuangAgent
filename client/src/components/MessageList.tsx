import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../lib/types';
import MessageItem from './MessageItem';

interface Props {
  messages: ChatMessage[];
  streamingId?: string;
}

export default function MessageList({ messages, streamingId }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = endRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, messages]);

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col gap-4 overflow-y-auto px-1 py-2"
    >
      {messages.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-center text-slate-400">
          <div>
            <p className="text-base font-medium text-slate-600">
              石家庄旅游助手 🤖
            </p>
            <p className="mt-1 text-xs">
              你好!我可以帮你规划行程或回答关于石家庄的任何问题~
            </p>
          </div>
        </div>
      )}
      {messages.map((m) => (
        <MessageItem
          key={m.id}
          message={m}
          streaming={streamingId === m.id}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
