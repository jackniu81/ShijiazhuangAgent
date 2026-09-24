import type { ReactNode } from 'react';
import ConnectionStatus from './ConnectionStatus';

interface Props {
  children: ReactNode;
  footer?: ReactNode;
}

export default function Layout({ children, footer }: Props) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            石家庄旅游助手
          </span>
          <ConnectionStatus />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-4 overflow-hidden">
        {children}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-3 text-xs text-slate-500">
          {footer ?? <span>石家庄旅游助手 · v{__APP_VERSION__}</span>}
        </div>
      </footer>
    </div>
  );
}
