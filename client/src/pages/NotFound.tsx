import { Link } from 'react-router';

export default function NotFound() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">404</h1>
      <p className="text-slate-600">That page doesn&apos;t exist.</p>
      <Link
        to="/"
        className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        ← Back home
      </Link>
    </section>
  );
}
