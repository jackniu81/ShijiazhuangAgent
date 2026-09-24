import type { ChatMessage } from '../lib/types';
import PlanCard from './PlanCard';
import StreamingText from './StreamingText';

interface Props {
  message: ChatMessage;
  streaming?: boolean;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export default function MessageItem({ message, streaming }: Props) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-3 animate-slide-up">
        <div className="max-w-[75%]">
          <div className="rounded-2xl rounded-tr-sm bg-emerald-500 px-4 py-2.5 text-sm text-white shadow-sm">
            {message.content}
          </div>
          <p className="mt-1 text-right text-[10px] text-slate-400">
            {formatTime(message.timestamp)}
          </p>
        </div>
        <div
          aria-hidden
          className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-xs font-semibold text-white shadow"
        >
          你
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    return (
      <div className="flex gap-3 animate-slide-up">
        <div
          aria-hidden
          className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-base shadow"
        >
          🤖
        </div>
        <div className="max-w-[85%]">
          {message.kind === 'plan' ? (
            <PlanCard plan={message.plan} />
          ) : (
            <div className="rounded-2xl rounded-tl-sm bg-white px-4 py-2.5 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200">
              {streaming ? (
                <StreamingText text={message.content} />
              ) : (
                <p className="whitespace-pre-wrap leading-relaxed">
                  {message.content}
                  {message.cancelled && (
                    <span className="ml-1 text-slate-400 line-through">
                      (已停止)
                    </span>
                  )}
                </p>
              )}
              {message.sources && message.sources.length > 0 && !streaming && (
                <ul className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
                  {message.sources.map((s) => (
                    <li
                      key={s}
                      className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500"
                    >
                      📎 {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="mt-1 text-[10px] text-slate-400">
            {formatTime(message.timestamp)}
          </p>
        </div>
      </div>
    );
  }

  // system
  const isError = message.type === 'error';
  return (
    <div className="flex justify-center animate-slide-up">
      <div
        className={[
          'rounded-full px-3 py-1 text-xs',
          isError
            ? 'bg-red-50 text-red-600 ring-1 ring-red-200'
            : 'bg-slate-100 text-slate-500',
        ].join(' ')}
      >
        {isError && '⚠️ '}
        {message.content}
      </div>
    </div>
  );
}
