import type { ReactNode } from 'react';
import AboutButton from './AboutButton';
import ConnectionStatus from './ConnectionStatus';

interface Props {
  children: ReactNode;
  footer?: ReactNode;
}

export default function Layout({ children, footer }: Props) {
  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            石家庄旅游助手
          </span>
          <div className="flex items-center gap-3">
            <AboutButton />
            <ConnectionStatus />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-4 overflow-y-auto">
        {children}
      </main>

      <footer className="sticky bottom-0 z-10 shrink-0 border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-3 text-xs text-slate-500">
          {footer ?? <span>石家庄旅游助手 · v{__APP_VERSION__}</span>}
        </div>
      </footer>
    </div>
  );
}
