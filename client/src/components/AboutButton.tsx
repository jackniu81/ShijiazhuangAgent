import { useCallback, useEffect, useState } from 'react';

/** 对齐 server VersionController GET /api/version 的返回结构。 */
interface ServerVersion {
  name: string;
  version: string;
  node: string;
  timestamp?: string;
}

const CAPABILITIES = [
  '基于本地景点资料的旅游问答,回答附引用来源',
  '多日行程规划,逐日流式展示路线与安排',
  '天气查询与未覆盖景点的补充检索(按问题自动调度)',
];

export default function AboutButton() {
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<ServerVersion | null>(null);
  const [failed, setFailed] = useState(false);

  // 每次打开时拉取一次当前在线 agent 的服务端信息(轻量接口,不缓存避免版本滞后)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    fetch('/api/version')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ServerVersion>;
      })
      .then((data) => {
        if (!cancelled) setServer(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="关于当前助手"
        title="关于"
        data-testid="about-btn"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-[18px] w-[18px]"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
          onClick={close}
          data-testid="about-backdrop"
          role="presentation"
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="关于石家庄旅游助手"
            data-testid="about-modal"
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">石家庄旅游助手</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  基于本地景点资料的石家庄旅游问答与行程规划 Agent
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="关闭"
                className="rounded-full px-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                data-testid="about-close"
              >
                ✕
              </button>
            </div>

            <section className="mt-4">
              <h3 className="text-xs font-medium text-slate-700">能力</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-600">
                {CAPABILITIES.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>

            <section className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <div className="flex justify-between gap-4">
                <span>客户端版本</span>
                <span className="font-mono text-slate-700">
                  v{__APP_VERSION__}
                  {__BUILD_TIME__ ? ` · ${__BUILD_TIME__.slice(0, 10)}` : ''}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>服务端</span>
                {server ? (
                  <span className="font-mono text-slate-700">
                    {server.name} v{server.version} · {server.node}
                  </span>
                ) : failed ? (
                  <span className="text-red-400">信息不可用(服务未连接)</span>
                ) : (
                  <span className="text-slate-400">读取中…</span>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
