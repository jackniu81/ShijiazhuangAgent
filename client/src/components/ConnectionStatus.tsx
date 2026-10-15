import { useCallback, useEffect, useState } from 'react';
import { agentSocket } from '../lib/socket';

export default function ConnectionStatus() {
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    agentSocket.connect();
    const handler = (c: boolean, err?: string) => {
      setConnected(c);
      setConnectError(c ? '' : err ?? '');
      // 恢复连接后关闭错误弹窗
      if (c) setOpen(false);
    };
    agentSocket.onConnectionChange(handler);
    setConnected(agentSocket.connected);
    return () => {
      agentSocket.offConnectionChange(handler);
    };
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // 握手被拒(如鉴权失败,issue #61)时给出明确文案,而非笼统"未连接"
  const label = connected ? '已连接' : connectError ? '未授权' : '未连接';

  const indicator = (
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

  return (
    <>
      {connected ? (
        indicator
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="查看连接失败原因"
          aria-label="连接失败,点击查看原因"
          data-testid="conn-status-btn"
          className="rounded-full transition hover:bg-red-50 px-1 py-0.5"
        >
          {indicator}
        </button>
      )}

      {open && !connected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
          onClick={close}
          data-testid="conn-error-backdrop"
          role="presentation"
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="连接失败原因"
            data-testid="conn-error-modal"
          >
            <div className="flex items-start justify-between">
              <h2 className="text-base font-semibold text-slate-900">连接失败</h2>
              <button
                type="button"
                onClick={close}
                aria-label="关闭"
                className="rounded-full px-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                data-testid="conn-error-close"
              >
                ✕
              </button>
            </div>

            <p className="mt-1 text-xs text-slate-500">
              {connectError
                ? '服务端拒绝了连接(通常为鉴权失败),具体原因:'
                : '无法连接到服务器,可能是服务未启动或网络不通。Socket.IO 会自动重试,若持续失败请检查服务状态。'}
            </p>

            {connectError && (
              <pre
                data-testid="conn-error-reason"
                className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-red-50 p-3 font-mono text-xs text-red-700 ring-1 ring-red-100"
              >
                {connectError}
              </pre>
            )}
          </div>
        </div>
      )}
    </>
  );
}
