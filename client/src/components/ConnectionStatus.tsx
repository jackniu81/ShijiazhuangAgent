import { useEffect, useState } from 'react';
import { agentSocket } from '../lib/socket';

export default function ConnectionStatus() {
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState('');

  useEffect(() => {
    agentSocket.connect();
    const handler = (c: boolean, err?: string) => {
      setConnected(c);
      setConnectError(c ? '' : err ?? '');
    };
    agentSocket.onConnectionChange(handler);
    setConnected(agentSocket.connected);
    return () => {
      agentSocket.offConnectionChange(handler);
    };
  }, []);

  // 握手被拒(如鉴权失败,issue #61)时给出明确文案,而非笼统"未连接"
  const label = connected ? '已连接' : connectError ? '未授权' : '未连接';

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={[
          'h-2 w-2 rounded-full',
          connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500',
        ].join(' ')}
        aria-label={label}
      />
      <span className={connected ? 'text-emerald-600' : 'text-red-500'} title={connectError || undefined}>
        {label}
      </span>
    </span>
  );
}
