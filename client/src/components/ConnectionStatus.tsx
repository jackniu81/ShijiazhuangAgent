import { useEffect, useState } from 'react';
import { agentSocket } from '../lib/socket';

export default function ConnectionStatus() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    agentSocket.connect();
    const handler = (c: boolean) => setConnected(c);
    agentSocket.onConnectionChange(handler);
    setConnected(agentSocket.connected);
    return () => {
      agentSocket.offConnectionChange(handler);
    };
  }, []);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={[
          'h-2 w-2 rounded-full',
          connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500',
        ].join(' ')}
        aria-label={connected ? '已连接' : '未连接'}
      />
      <span className={connected ? 'text-emerald-600' : 'text-red-500'}>
        {connected ? '已连接' : '未连接'}
      </span>
    </span>
  );
}
