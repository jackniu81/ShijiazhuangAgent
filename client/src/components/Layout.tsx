import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    'px-3 py-2 rounded-md text-sm font-medium transition-colors',
    isActive
      ? 'bg-slate-900 text-white'
      : 'text-slate-600 hover:bg-slate-100',
  ].join(' ');

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            NestJS + React
          </span>
          <nav className="flex gap-1">
            <NavLink to="/" end className={navClass}>
              Welcome
            </NavLink>
            <NavLink to="/about" className={navClass}>
              About
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        {children}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 text-xs text-slate-500">
          <span>NestJS + React Full Stack Starter · v{__APP_VERSION__}</span>
          <span title="Build timestamp">2026.09 · built {__BUILD_TIME__}</span>
        </div>
      </footer>
    </div>
  );
}
